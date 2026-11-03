// Node-side gates for the bone friends (src/v2/render/skeletons.js, src/v2/hideout-spot.js; design/45-bone-friends.md).
//
//   node scripts/check-skeletons.mjs
//
// Where the lost boy hides in a castle and a cave, and the skeleton's life on a stand-in body: shy at its hideout, coaxed
// and tamed with a bone, collapsing when rushed and getting up again, following her, begging for a pumpkin and taking it
// only from her hand, the boy found. What this can NOT check: how the clips look, or that the eyes sit in the sockets.

import * as THREE from 'three'
import { setPuppetMode } from '../src/v2/render/baked-puppet.js'
import { castleLayout } from '../src/v2/castles/layout.js'
import { castleSolids, interiorSpans, SPANS } from '../src/v2/castles/solids.js'
import { WalkSurface } from '../src/v2/walk.js'
import { caveSpot, castleSpot, ghostSpot, BODY_M, HEAD_M } from '../src/v2/hideout-spot.js'
import { CastleGhost, GHOST } from '../src/v2/render/ghost.js'
import { dungeonCell, dungeonPlan } from '../src/v2/castles/dungeon.js'
import { TRADES } from '../src/v2/layers/trades.js'
import { Skeletons, SKELETON, CLIPS, placeKey } from '../src/v2/render/skeletons.js'
import { TOWNSFOLK } from '../src/v2/render/townsfolk.js'
import { LOD_RUNGS } from '../src/v2/render/critters.js'
import { EAT, Effects, edible } from '../src/v2/eating.js'
import { Wisps, WISP } from '../src/v2/render/wisps.js'
import { Sheets } from '../src/v2/render/sheets.js'
import { Treats, doorOnRay, nightOf } from '../src/v2/treats.js'

setPuppetMode('skinned')

/** Whether interior (x, z) is floor at `y` with `head` m of air over it, by the castle's real collision. */
function floorOpen(it, x, z, y, head, tol = 0.05) {
  const n = interiorSpans(it, x, z, y + 0.5)
  for (let i = 0; i < n; i++) if (Math.abs(SPANS.HI[i] - y) < tol && (i + 1 >= n || SPANS.LO[i + 1] - SPANS.HI[i] >= head)) return true
  return false
}
/** Whether the `r` disc about (x, z) at floor `y` is open floor with HEAD_M over it: its centre and a ring of sixteen. */
const discOpen = (it, x, z, y, r) => floorOpen(it, x, z, y, HEAD_M) && Array.from({ length: 16 }, (_, k) => floorOpen(it, x + Math.cos(k * Math.PI / 8) * r, z + Math.sin(k * Math.PI / 8) * r, y, HEAD_M)).every(Boolean)
/** Whether dungeon cell `to` is reached from the foot's cells over open dungeon cells. */
function connected(d, [i0, j0], to) {
  const seen = new Set([i0 + j0 * d.W]), queue = [i0 + j0 * d.W]
  for (let q = 0; q < queue.length; q++) {
    const c = queue[q], i = c % d.W, j = Math.floor(c / d.W)
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = i + di + (j + dj) * d.W
      if (i + di < 0 || i + di >= d.W || j + dj < 0 || j + dj >= d.D || seen.has(n) || Number.isNaN(d.lo[n])) continue
      seen.add(n); queue.push(n)
    }
  }
  return seen.has(to)
}

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

// --- the hideout spots -----------------------------------------------------------
{
  for (const seed of [1, 3, 8, 215679, 311021, 2, 77]) {
    const lay = castleLayout(seed), d = dungeonPlan(lay), it = castleSolids(lay).it
    const spot = castleSpot(lay)
    check(spot !== null, `castle ${seed}: it has a hideout`)
    if (spot === null) continue
    const room = d.rooms[spot.room], cell = dungeonCell(d, spot.lx, spot.lz), boyCell = dungeonCell(d, spot.boy.lx, spot.boy.lz)
    const g = ghostSpot(lay), ghostRoom = d.rooms.find((r) => r.rect[0] < g.lx && g.lx < r.rect[2] && r.rect[1] < g.lz && g.lz < r.rect[3])
    check(spot.ly < 0 && Math.abs(spot.ly - d.lo[cell]) < 1e-9, `castle ${seed}: the boy hides in the dungeon, below storey 0, on its floor`, `ly ${spot.ly}`)
    check(room.rect[0] < spot.lx && spot.lx < room.rect[2] && room.rect[1] < spot.lz && spot.lz < room.rect[3] && !room.flooded && Number.isNaN(d.water[cell]) && Number.isNaN(d.water[boyCell]), `castle ${seed}: in a dry dungeon room`)
    check(spot.room !== d.chest && room !== ghostRoom, `castle ${seed}: not the chest's room nor the ghost's`, `room ${spot.room} chest ${d.chest}`)
    check(discOpen(it, spot.lx, spot.lz, spot.ly, BODY_M) && discOpen(it, spot.boy.lx, spot.boy.lz, spot.ly, BODY_M), `castle ${seed}: a ${BODY_M} m disc about the skeleton and about the boy is open floor with ${HEAD_M} m of head room`)
    check(Math.abs(Math.hypot(spot.boy.lx - spot.lx, spot.boy.lz - spot.lz) - 0.9) < 1e-6, `castle ${seed}: the boy sits beside the skeleton, 0.9 m off`)
    check(connected(d, d.foot.cells, cell), `castle ${seed}: its room is reachable on dungeon floor from the foot chamber`)
  }
  // A graph: two mouths, a chamber two walks in, a deeper one past it, a deeper still behind a climb, and a wet one deepest.
  const nodes = [
    { i: 0, kind: 'mouth', x: 0, z: 0, y: 0, dish: 0 },
    { i: 1, kind: 'junction', x: 5, z: 0, y: -2, dish: 0 },
    { i: 2, kind: 'chamber', x: 10, z: 0, y: -4, dish: 0 },
    { i: 3, kind: 'chamber', x: 15, z: 0, y: -6, dish: 0 },
    { i: 4, kind: 'chamber', x: 20, z: 0, y: -12, dish: 0 },
    { i: 5, kind: 'chamber', x: 25, z: 0, y: -14, dish: 1 },
    { i: 6, kind: 'mouth', x: 0, z: 9, y: 0, dish: 0 },
  ]
  const edges = [{ a: 0, b: 1, kind: 'walk' }, { a: 1, b: 2, kind: 'walk' }, { a: 2, b: 3, kind: 'walk' }, { a: 3, b: 4, kind: 'climb' }, { a: 3, b: 5, kind: 'walk' }, { a: 6, b: 1, kind: 'walk' }]
  const c = caveSpot({ nodes, edges })
  check(c !== null && c.node === 3, 'a cave: the dry chamber the most walks from any mouth, past no climb and no pool', c && `node ${c.node}`)
  check(caveSpot({ nodes: nodes.slice(0, 2), edges: edges.slice(0, 1) }).node === 1, 'a cave of no chamber: its junction')
}

// --- a stand-in body: the shipped skeleton's bone names, every clip a second ------
function makeAsset(height = 1) {
  const root = new THREE.Bone()
  root.name = 'Pelvis'
  root.position.set(0, 0.42 * height, 0)
  // Named as GLTFLoader leaves them, the dot dropped.
  const named = (name, x, y, z) => { const b = new THREE.Bone(); b.name = THREE.PropertyBinding.sanitizeNodeName(name); b.position.set(x, y, z); root.add(b); return b }
  const bones = [root, named('Head', 0, 0.38 * height, 0), named('Wrist.R', 0.1, 0.05, 0.2), named('Wrist.L', 0.1, 0.05, -0.2)]
  const legs = []
  for (const side of ['L', 'R']) {
    const hip = named(`Hip.${side}`, 0, -0.03, side === 'L' ? -0.08 : 0.08)
    const knee = new THREE.Bone(); knee.name = `Knee${side}`; knee.position.set(0.02, -0.18, 0); hip.add(knee)
    const ankle = new THREE.Bone(); ankle.name = `Ankle${side}`; ankle.position.set(-0.02, -0.18, 0); knee.add(ankle)
    bones.push(hip, knee, ankle)
    legs.push({ id: side, chain: [`Hip.${side}`, `Knee.${side}`, `Ankle.${side}`] })
  }
  root.updateMatrixWorld(true)
  const skeleton = new THREE.Skeleton(bones, bones.map((b) => b.matrixWorld.clone().invert()))
  const tiers = Array.from({ length: LOD_RUNGS }, () => {
    const g = new THREE.BoxGeometry(0.3, height, 0.5).translate(0, height / 2, 0)
    const n = g.getAttribute('position').count
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4))
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4))
    return g
  })
  const clips = [...CLIPS, 'sit'].map((name) => new THREE.AnimationClip(name, 1, [new THREE.QuaternionKeyframeTrack('Pelvis.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1])]))
  return { root, skeleton, tiers, clips, map: null, height, gait: { walk: 0.5, run: 2.34 }, legs }
}

// --- a world: flat ground, her hands, a hideout and its lost boy ------------------
/** Flat ground at the foot height asked of it, with a wall slab 0.4 m thick across x = `wallX` (none while Infinity). */
function stubWalk() {
  const walk = { wallX: Infinity, heightAt: (x, z, y) => (y === undefined ? 0 : y), fits: (x, z, y, out, r) => Math.abs(x - walk.wallX) >= 0.2 + r, normalAt: (x, z, e, out) => out, obstacleAt: () => null }
  return walk
}
function makeWorld(walk = stubWalk()) {
  const lures = []
  const eaten = []
  const carriers = []
  const hands = {
    loose: [],
    lures(into) { for (const l of lures) into.push(l); return into },
    eatLure(lure, eater) {
      const i = lures.indexOf(lure)
      if (i < 0) return null
      lures.splice(i, 1)
      eaten.push({ kind: lure.kind, eater })
      return { kind: lure.kind, name: lure.kind, size: 0.36, scale: [1, 1, 1] }
    },
    carry(owner) {
      const items = []
      const c = { owner, items, gripped: 0, add(rec) { items.push(rec) }, count: () => items.length, grip() { c.gripped++ }, scatter() { items.length = 0 }, release() { items.length = 0 } }
      carriers.push(c)
      return c
    },
    lift(item) { this.loose.splice(this.loose.indexOf(item), 1) },
  }
  const quest = { id: 'child:0:1', where: { kind: 'castle', site: '3,4' } }
  const child = { body: TOWNSFOLK.bodies[0] }
  let state = 'open'
  const conv = {
    world: { hideouts: [{ kind: 'castle', site: '3,4' }, { kind: 'cave', system: 7 }] },
    lost: () => (state === 'open' ? [{ quest, child }] : []),
    found(id) { if (id !== quest.id) throw new Error(`found ${id}`); state = 'found' },
    get state() { return state },
  }
  const boyAsset = makeAsset(0.9)
  const townsfolk = { bodies: TOWNSFOLK.bodies.map(() => ({ asset: boyAsset, heightM: 1.2, height: 0.9 })), lazy: { want() {} } }
  const friends = new Set()
  const layer = new Skeletons(new THREE.Scene(), { walk, hands, pumpkins: {}, townsfolk, conv: () => conv, friends, bones: ['skull'], fetches: ['stick'], asset: makeAsset() })
  return { layer, walk, lures, eaten, carriers, hands, conv, friends }
}

const DT = 1 / 30
/** `s` seconds of frames, her feet at `at()` (re-read each frame) and her head 1.5 m over them. */
function run(w, s, at, t0 = { now: 0 }) {
  for (let i = 0; i < Math.round(s / DT); i++) {
    const f = at(t0.now)
    t0.now += DT
    w.layer.update(DT, t0.now, f, { x: f.x, y: f.y + 1.5, z: f.z })
  }
  return t0
}
const site = { id: '3,4', seed: 3, x: 100, z: 50, yaw: 0.4 }

{
  const w = makeWorld()
  const clock = { now: 0 }
  check(placeKey({ kind: 'castle', site: '3,4' }) === 'castle:3,4' && placeKey({ kind: 'cave', system: 7 }) === 'cave:7', 'a hideout names its place as the layer keys the place she is in')
  w.layer.intoCastle({ ...site, id: '9,9' }, 320, w.walk)
  run(w, 0.5, () => ({ x: 0, y: 320, z: 0 }), clock)
  check(w.layer.list.length === 0 && w.layer.boy === null && w.layer.lying.length === 0, 'a castle that is no town\'s hideout has no skeleton, boy or bones')

  w.layer.intoCastle(site, 320, w.walk)
  const far = () => ({ x: site.x + 30, y: 320, z: site.z })
  run(w, 0.5, far, clock)
  const b = w.layer.list[0]
  const place = w.layer.place
  // She comes at it from its far side from the boy, never within foundM of him before 'Finding the boy'.
  const away = Math.atan2(place.z - w.layer.boy.z, place.x - w.layer.boy.x)
  check(w.layer.list.length === 1 && !b.tame && b.state === 'hide' && b.clip === 'cower', 'the hideout\'s skeleton is shy: cowering at home')
  check(w.layer.lying.length === SKELETON.stash, `${SKELETON.stash} bones lie by it for her to feed it with`)
  check(w.layer.boy !== null && w.layer.boy.clip === 'gather' && Math.hypot(w.layer.boy.x - place.x, w.layer.boy.z - place.z) < 1.5, 'the lost boy crouches by it, playing with its bones')
  check(Math.abs(place.y - (320 + castleSpot(castleLayout(3)).ly)) < 1e-9, 'it stands on the dungeon room\'s floor, the interior\'s height over the castle')

  // Her pick of a stash bone, by the hands source.
  const lie = w.layer.lying[0]
  const hit = w.layer.pickAt(lie.x, lie.y + 0.05, lie.z, 0.2)
  const rec = hit && w.layer.take(hit)
  check(rec !== null && rec.kind === 'bone' && rec.geometry.isBufferGeometry && rec.material.isMaterial && w.layer.lying.length === SKELETON.stash - 1, 'a stash bone picks up as a bone record, gone from the ground')
  const cap = w.layer.caps[0]
  const capHit = w.layer.pickAt(cap.x, cap.y + 0.06, cap.z, 0.2)
  const capRec = capHit && w.layer.take(capHit)
  check(w.layer.caps.length === SKELETON.caps - 1 && capRec.kind === 'ghostcap' && edible(capRec) && w.layer.dress(capRec).material.isMeshBasicMaterial, 'ghost caps glow by its hideout, and one picks up as a thing she can eat')
  const fx = new Effects()
  check(fx.eat(capRec).harm === 0 && fx.floating && !fx.maddened, 'eaten, a ghost cap does her no harm and holds her up')
  for (let t = 0; t < EAT.ghost.s + EAT.ghost.outS + 0.1; t += 0.5) fx.update(0.5)
  check(!fx.floating && fx.ghostly === 0 && fx.tint[3] === 0, 'and lets her down once it wears off')

  // Rushing it collapses it; it gets up again where it was.
  const home = { x: b.x, z: b.z }
  let rush = 4.5
  run(w, 0.6, () => { rush -= 4 * DT; return { x: place.x + rush * Math.cos(away), y: place.y, z: place.z + rush * Math.sin(away) } }, clock)
  check(b.state === 'pile' || b.state === 'rise', 'she running at a shy one collapses it into a pile', b.state)
  check(w.layer.said.some((v) => v.sound === 'skeletonCollapse'), 'it clatters down')
  check(w.layer.carriers === undefined && w.carriers.length === 0, 'with nothing to drop')
  run(w, SKELETON.pileS[1] + 1.5, far, clock)
  check(b.state === 'hide' && b.squash === 0 && Math.hypot(b.x - home.x, b.z - home.z) < 0.01, 'and reassembles, cowering where it was', b.state)
  check(w.layer.voices([]).some((v) => v.sound === 'skeletonReassemble'), 'with a rattle of putting itself together')

  // A bone held out draws it out; held at its head, it eats and is hers.
  const stand = { x: place.x + 3 * Math.cos(away), y: place.y, z: place.z + 3 * Math.sin(away) }
  const bone = { kind: 'bone', x: stand.x - 0.4, y: place.y + 0.95, z: stand.z, by: null }
  w.lures.push(bone)
  run(w, 8, () => stand, clock)
  check(w.eaten.some((e) => e.kind === 'bone' && e.eater === 'skeleton'), 'a bone held out within reach of a shy one: it walks up and eats it from her hand')
  run(w, 1.5 + SKELETON.joyS, () => stand, clock)
  check(b.tame && w.friends.has('castle:3,4'), 'fed, it is tame, and its place is saved among her friends')
  check(b.state === 'follow' || b.state === 'fidget', 'and follows her', b.state)

  // Finding the boy.
  run(w, 3, () => ({ x: w.layer.boy.x + 1, y: place.y, z: w.layer.boy.z }), clock)
  check(w.conv.state === 'found' && w.layer.boy !== null && w.layer.boy.clip === 'wave', 'her walking up to the lost boy finds him, and he waves')
  run(w, SKELETON.goneS + 2, () => stand, clock)
  check(w.layer.boy === null, 'then he is off home')

  // Leaving: the follower comes along, put beside her.
  w.layer.outside(w.walk)
  const out = { x: -500, y: 0, z: 20 }
  run(w, 0.2, () => out, clock)
  check(w.layer.list.length === 1 && w.layer.list[0] === b && Math.hypot(b.x - out.x, b.z - out.z) < SKELETON.followM + 0.5 && b.y === 0, 'out of the castle, her friend is beside her on the ground outside', `${b.x.toFixed(1)},${b.z.toFixed(1)} y ${b.y}`)
  check(w.layer.lying.length === 0 && w.layer.place === null, 'the hideout\'s bones stay behind')

  // She walks off; it keeps up.
  let x = out.x
  run(w, 12, () => { x += 1.4 * DT; return { x, y: 0, z: out.z } }, clock)
  check(Math.hypot(b.x - x, b.z - out.z) < SKELETON.runM + 1, 'walking off, she is kept up with', Math.hypot(b.x - x, b.z - out.z).toFixed(2))
  run(w, 0.1, () => ({ x: x + 200, y: 0, z: out.z }), clock)
  check(Math.hypot(b.x - x - 200, b.z - out.z) < SKELETON.followM + 0.5, 'and past lostM it is put beside her, not left behind')

  // A pumpkin: it comes, kneels, begs; held near its hands, it takes it slowly, cheers, romps, and carries it.
  const me = { x: b.x + 4, y: 0, z: b.z }
  const pumpkin = { kind: 'pumpkin', x: me.x, y: 1.1, z: me.z, by: null }
  w.lures.push(pumpkin)
  run(w, 6, () => me, clock)
  check(b.state === 'beg' && b.clip === 'beg' && Math.abs(Math.hypot(b.x - me.x, b.z - me.z) - SKELETON.kneelM) < 0.3, 'a pumpkin in her hand: it comes, kneels in front of her and begs', `${b.state} ${Math.hypot(b.x - me.x, b.z - me.z).toFixed(2)}`)
  check(w.layer.voices([]).some((v) => v.sound === 'skeletonWhimper'), 'whimpering for it')
  check(w.eaten.every((e) => e.kind !== 'pumpkin'), 'held out of its reach, it never takes it')
  // Into its hands.
  b.puppet.named['Wrist.R'].updateMatrixWorld(true)
  const wrist = new THREE.Vector3().setFromMatrixPosition(b.puppet.named['Wrist.R'].matrixWorld).applyMatrix4(b.puppet.group.matrix)
  pumpkin.x = wrist.x; pumpkin.y = wrist.y; pumpkin.z = wrist.z
  run(w, 0.2, () => me, clock)
  check(b.state === 'take' && b.rate === SKELETON.takeRate, 'offered at its hands, it reaches for it, slowly', `${b.state} rate ${b.rate}`)
  run(w, 1 / SKELETON.takeRate - 0.4, () => me, clock)
  check(w.eaten.every((e) => e.kind !== 'pumpkin'), 'and not before the slow reach is done')
  run(w, 0.5, () => me, clock)
  const carrier = w.carriers.find((c) => c.owner === 'skeleton:castle:3,4')
  check(w.eaten.some((e) => e.kind === 'pumpkin' && e.eater === 'skeleton') && carrier && carrier.count() === 1, 'then it is out of her hand and in its arms')
  check(b.state === 'joy', 'and it jumps for joy', b.state)
  run(w, SKELETON.joyS + 2, () => me, clock)
  check(b.state === 'romp' && b.clip === 'run-carry' && Math.abs(Math.hypot(b.x - me.x, b.z - me.z) - SKELETON.rompR) < 0.8, 'then runs round her holding it up', `${b.state} ${b.clip} r ${Math.hypot(b.x - me.x, b.z - me.z).toFixed(2)}`)
  run(w, SKELETON.rompS, () => me, clock)
  check(b.state !== 'romp' && carrier.count() === 1 && carrier.gripped > 0, 'and keeps it after, gripped in its hands')

  // A blade through a friend collapses it instead of killing it, and it drops what it holds.
  w.layer.blades = [{ x: b.x, y: b.y + 0.5, z: b.z }]
  run(w, DT, () => me, clock)
  w.layer.blades = []
  check(b.state === 'pile' && carrier.count() === 0 && w.layer.list.includes(b), 'a sword through it: it collapses and drops the pumpkin, and is still there')
  run(w, SKELETON.pileS[1] + 2, () => me, clock)
  check(b.state === 'follow' || b.state === 'fidget', 'and gets back up to follow her', b.state)

  // The spiders and the ear.
  const scare = w.layer.scarers([])
  check(scare.length === 1 && scare[0].foot === b.y && scare[0].y > b.y, 'a standing skeleton is a body the spiders flee')
  const bodies = w.layer.bodies([])
  check(bodies.length === 1 && bodies[0].size === SKELETON.heightM && typeof bodies[0].clip === 'string', 'and a body the ear hears step')

  // A fetch: a stick come to rest away from her is brought back to her feet.
  const stick = { rec: { kind: 'stick', size: 0.5 }, src: {}, state: 'still', x: me.x + 8, y: 0, z: me.z }
  w.hands.loose.push(stick)
  run(w, 15, () => me, clock)
  check(!w.hands.loose.includes(stick) && w.carriers.some((c) => c.owner === 'skeleton:castle:3,4'), 'a stick she threw: it fetches it and drops it at her feet')

  // A new game forgets the friends.
  w.friends.clear()
  run(w, DT, () => me, clock)
  check(w.layer.list.length === 0 && w.layer.eyes.count === 0, 'her friends cleared, it is gone, eyes and all')
}

{
  // Friends saved: on load, they are beside her without any hideout.
  const w = makeWorld()
  w.friends.add('cave:7'); w.friends.add('castle:3,4')
  run(w, 0.2, () => ({ x: 10, y: 0, z: 10 }))
  check(w.layer.list.length === 2 && w.layer.list.every((b) => b.tame && Math.hypot(b.x - 10, b.z - 10) < SKELETON.followM + 0.5), 'saved friends are beside her the moment the game loads')
  w.layer.intoCave({ id: 7 }, { nodes: [{ i: 0, kind: 'mouth', x: 0, z: 0, y: 0, dish: 0 }, { i: 1, kind: 'chamber', x: 9, z: 0, y: -3, dish: 0 }], edges: [{ a: 0, b: 1, kind: 'walk' }] }, -2000, w.walk)
  run(w, 0.2, () => ({ x: 0, y: -2000, z: 0 }))
  check(w.layer.list.length === 2 && w.layer.list.every((b) => b.tame), 'its own hideout entered again, a tamed skeleton is not there twice')
  check(w.layer.lying.length === SKELETON.stash, 'though its bones are')
}

// --- walls: the hideout's bones and caps, and every step, stay on open floor -----------
/** The real interior walk of `lay`, in interior metres (a site at the origin, unturned, its floor at 0). */
function interiorWalk(it) {
  const stone = {
    columnAt(x, z, _m, out, foot) {
      const n = interiorSpans(it, x, z, (foot === undefined ? -5.5 : foot) + 0.5)
      for (let i = 0; i < n; i++) { out[i * 2] = SPANS.LO[i]; out[i * 2 + 1] = SPANS.HI[i] }
      return n
    },
    blockTopAt(x, z) {
      const n = interiorSpans(it, x, z, -5.5)
      let top = -Infinity
      for (let i = 0; i < n; i++) if (SPANS.HI[i] < 999) top = Math.max(top, SPANS.HI[i])
      return top
    },
    deckAt: () => true,
  }
  return new WalkSurface({ heightAt: () => it.base }, stone, { trunkAt: () => false })
}
/** Whether a body of `r` can stand at interior (x, z) on floor `y` (a body rides up to 0.15 m off a floor): open floor at its centre and ring, `head` of air over each. */
const bodyOpen = (it, x, z, y, r, head) => floorOpen(it, x, z, y, head, 0.15) && Array.from({ length: 8 }, (_, k) => floorOpen(it, x + Math.cos(k * Math.PI / 4) * r, z + Math.sin(k * Math.PI / 4) * r, y, head, 0.15)).every(Boolean)

for (const seed of [1, 3, 8, 215679, 311021]) {
  const lay = castleLayout(seed), it = castleSolids(lay).it, w = makeWorld(interiorWalk(it))
  const there = { id: '3,4', seed, x: 0, z: 0, yaw: 0 }
  w.layer.intoCastle(there, 0, w.walk)
  run(w, 0.2, () => ({ x: 40, y: 0, z: 40 }))
  const b = w.layer.list[0], boy = w.layer.boy, y = w.layer.place.y
  check(b !== undefined && boy !== null && b.y === y, `castle ${seed}: the skeleton and the lost boy stand on the dungeon floor`)
  check(bodyOpen(it, b.x, b.z, y, SKELETON.bodyM, SKELETON.heightM) && bodyOpen(it, boy.x, boy.z, y, SKELETON.bodyM, SKELETON.heightM), `castle ${seed}: neither is in the wall: both stand on open floor with a shoulder clear of stone`)
  check(w.layer.lying.length === SKELETON.stash && w.layer.lying.every((l) => floorOpen(it, l.x, l.z, y, 0.5)), `castle ${seed}: every bone laid out lies on open floor`)
  check(w.layer.caps.length === SKELETON.caps && w.layer.caps.every((c) => floorOpen(it, c.x, c.z, y, 0.5)), `castle ${seed}: every ghost cap grows on open floor`)
}

{
  // Walking at a wall: a stand-in slab across its way.
  const w = makeWorld()
  w.layer.intoCastle({ ...site, id: '9,9' }, 0, w.walk)
  w.friends.add('castle:3,4')
  const clock = { now: 0 }
  run(w, 0.2, () => ({ x: 0, y: 0, z: 0 }), clock)
  const b = w.layer.list[0]
  w.walk.wallX = 5
  const across = () => ({ x: 12, y: 0, z: 0 })
  let deepest = -Infinity
  for (let i = 0; i < Math.round(2.9 / DT); i++) { run(w, DT, across, clock); deepest = Math.max(deepest, b.x) }
  check(b.x > 3 && deepest + SKELETON.bodyM <= w.walk.wallX - 0.2 + 1e-6, 'a follower sent at a wall walks up to it and stops there, never into it', `x ${b.x.toFixed(2)} deepest ${deepest.toFixed(2)}`)
  check(b.stuck > 0 && b.x < w.walk.wallX, 'and stays pressed against it, not through')
  run(w, SKELETON.stuckS, across, clock)
  check(Math.hypot(b.x - 12, b.z) < SKELETON.followM + 0.5, 'pressed on it too long, it is put beside her on the far side', `x ${b.x.toFixed(2)}`)
}

{
  // The same on the real dungeon: she on the far side of rock from it.
  const seed = 3, lay = castleLayout(seed), it = castleSolids(lay).it, d = dungeonPlan(lay), w = makeWorld(interiorWalk(it))
  const at = castleSpot(lay)
  const far = d.rooms.filter((r, i) => i !== at.room && r.rect[2] - r.rect[0] >= 3 && Math.hypot(r.node.i + d.x0 - at.lx, r.node.j + d.z0 - at.lz) < 25).map((r) => ({ r, x: d.x0 + r.node.i + 0.5, z: d.z0 + r.node.j + 0.5 })).filter(({ x, z }) => { for (let t = 0.1; t < 0.9; t += 0.05) if (!floorOpen(it, at.lx + (x - at.lx) * t, at.lz + (z - at.lz) * t, at.ly, 0.5)) return true; return false })
  check(far.length > 0, 'a dungeon room beyond rock from the hideout to walk her to')
  w.friends.add('castle:3,4')
  w.layer.intoCastle({ id: '3,4', seed, x: 0, z: 0, yaw: 0 }, 0, w.walk)
  const clock = run(w, 0.3, () => ({ x: at.lx, y: at.ly, z: at.lz }))
  const b = w.layer.list[0], goal = far[0]
  let inStone = 0, frames = 0
  const to = () => ({ x: goal.x, y: at.ly, z: goal.z })
  for (let s = 0; s < 2.9; s += DT) { run(w, DT, to, clock); frames++; if (!bodyOpen(it, b.x, b.z, b.y, SKELETON.bodyM, SKELETON.heightM)) inStone++ }
  check(frames > 0 && inStone === 0, 'a follower sent at her through the dungeon\'s rock is never once in stone', `${inStone} of ${frames} frames, at ${b.x.toFixed(1)},${b.z.toFixed(1)}`)
  for (let s = 0; s < 20; s += DT) { run(w, DT, to, clock); if (!bodyOpen(it, b.x, b.z, b.y, SKELETON.bodyM, SKELETON.heightM)) inStone++ }
  check(inStone === 0, 'nor in the twenty seconds after, whether it finds its way round or is put beside her', `${inStone} frames in stone`)
}

// --- the wisps -------------------------------------------------------------------
{
  const wisps = new Wisps(new THREE.Scene())
  const places = [{ key: 'cave:7', x: 100, z: 0 }]
  const feet = { x: 0, y: 0, z: 0 }
  const go = (s, opts) => { for (let t = 0; t < s; t += 0.05) wisps.update(0.05, t, feet, { dayness: 0, outdoors: true, places, heightAt: () => 0, ...opts }) }
  go(1, { dayness: 0.9 })
  check(!wisps.group.visible, 'the wisps are not out by day')
  go(WISP.fadeS + 0.5)
  check(wisps.group.visible && wisps.stats.target === 'cave:7', 'after dark they show for the hideout near her', JSON.stringify(wisps.stats))
  const first = wisps.stats.at.x
  check(Math.abs(first - WISP.aheadM) < 0.5, 'waiting a little ahead of her toward it', first.toFixed(2))
  feet.x = first
  go(WISP.hopM / WISP.speedMps + 1)
  check(wisps.stats.at.x > first + WISP.hopM - 0.5, 'and drifting on toward it when she catches up', wisps.stats.at.x.toFixed(2))
  go(0.1, { outdoors: false })
  check(!wisps.group.visible, 'gone the moment she is indoors')
  go(WISP.fadeS + 0.5, { places: [] })
  check(!wisps.group.visible, 'and none for a hideout whose skeleton is already hers')
  wisps.dispose()
}

// --- the sheet ghosts ------------------------------------------------------------
{
  const sheets = new Sheets(new THREE.Scene())
  const kid = (clip, extra = {}) => ({ role: 'child', hidden: false, size: 1.2, pose: { x: 3, y: 1, z: 4, heading: 0, clip }, ...extra })
  const shown = [kid('walk'), kid('sit'), kid('walk', { hidden: true }), kid('walk', { role: 'guard' })]
  sheets.update(shown, 0.9)
  check(sheets.worn === 0, 'no child wears a sheet by day')
  sheets.update(shown, 0)
  check(sheets.worn === 1, 'after dark a child about the town wears one; one sitting, gone in, or grown does not', `${sheets.worn}`)
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3()
  sheets.mesh.getMatrixAt(0, m)
  m.decompose(p, q, s)
  check(p.distanceTo(new THREE.Vector3(3, 1, 4)) < 1e-6 && Math.abs(s.y - 1.2) < 1e-6, 'standing on its feet, as tall as the child')
  sheets.geometry.computeBoundingBox()
  const box = sheets.geometry.boundingBox
  check(box.max.y > 1 && box.min.y > 0.1 && box.max.x > box.max.z * 0.9, 'over its head, its feet showing below the hem')
  sheets.dispose()
}

// --- trick-or-treat --------------------------------------------------------------
{
  const doors = [{ key: '0:0', x: 0, y: 0, z: 5 }, { key: '0:1', x: 0, y: 0, z: 9 }, { key: '0:2', x: 4, y: 0, z: 5 }]
  const eye = { x: 0, y: 1.5, z: 0 }, ahead = new THREE.Vector3(0, -0.4 / 5, 1).normalize()
  check(doorOnRay(eye, ahead, 6, doors)?.key === '0:0', 'a knock lands on the nearest door the ray reaches')
  check(doorOnRay(eye, ahead, 2, doors) === null, 'never on one past her reach')
  check(doorOnRay(eye, new THREE.Vector3(0, 0, -1), 20, doors) === null, 'nor one behind her')
  const answered = new Set()
  const treats = new Treats(4242, answered)
  const got = treats.knock('0:0', nightOf(20))
  check(got === 'candy' || got === 'ghostcap', 'a door answers a knock with a sweet or a ghost cap', got)
  check(treats.knock('0:0', nightOf(23.5)) === null && treats.knock('0:0', nightOf(24 + 3)) === null, 'and not again that night, past midnight too')
  check(treats.knock('0:0', nightOf(24 + 19)) !== null, 'but again the next evening')
  const kinds = new Set(Array.from({ length: 200 }, (_, i) => treats.knock(`1:${i}`, 3)))
  check(kinds.has('candy') && kinds.has('ghostcap'), 'some doors hand out ghost caps, others sweets')
  const sweet = treats.slot('candy')
  check(edible({ ...sweet, ...treats.dress(sweet) }) && new Effects().eat(sweet).heal === EAT.heal, 'a sweet is food that heals')
  check(treats.pickAt() === null, 'no sweet lies in the world')
  treats.dispose()
}

// --- the castle ghost ------------------------------------------------------------
{
  for (const seed of [1, 2, 3, 77, 991, 4242]) {
    const lay = castleLayout(seed), g = ghostSpot(lay), d = dungeonPlan(lay)
    const room = g && d.rooms.find((r) => r.rect[0] < g.lx && g.lx < r.rect[2] && r.rect[1] < g.lz && g.lz < r.rect[3])
    const cell = g && dungeonCell(d, g.lx, g.lz)
    check(g !== null && room !== undefined && room !== d.entry && Number.isNaN(d.water[cell]) && Math.abs(g.ly - d.lo[cell]) < 1e-9, `castle ${seed}: its ghost drifts on a dry dungeon floor past the entry room`, room && `depth ${room.depth}`)
  }
  const ghost = new CastleGhost(new THREE.Scene())
  const site = { id: '3,4', seed: 3, x: 100, z: 50, yaw: 0.4 }
  ghost.into(site, 320)
  check(ghost.at !== null && Math.abs(ghost.at.y - 320 - ghostSpot(castleLayout(3)).ly - GHOST.lift) < 1e-9 && TRADES.bodies.includes(ghost.body), 'in its castle, it floats over the dungeon floor in a townsfolk body', ghost.at && `${ghost.at.y} ${ghost.body}`)
  const her = { x: ghost.at.x, z: ghost.at.z + 5 }
  for (let i = 0; i < 300; i++) ghost.update(1 / 30, i / 30, her, true)
  const fwd = new THREE.Vector3(1, 0, 0).applyEuler(ghost.mesh.rotation)
  check(ghost.mesh.visible && fwd.z > 0.99, 'shown, it turns to face her', `${fwd.x.toFixed(2)}, ${fwd.z.toFixed(2)}`)
  ghost.voices([])
  const heard = []
  ghost.whisper(10)
  ghost.voices(heard)
  check(heard.length === 1 && heard[0].sound === 'ghostWhisper' && heard[0].gain === 1, 'each line it speaks comes with a whisper')
  const murmurs = []
  for (let i = 0; i < 60 * 30; i++) { ghost.update(1 / 30, 10 + i / 30, her, true); ghost.voices(murmurs) }
  check(murmurs.length >= 3 && murmurs.every((v) => v.sound === 'ghostWhisper' && v.gain === GHOST.murmur) && murmurs.length <= 60 / GHOST.murmurS[0], 'near it, it murmurs now and then, softer than it speaks', `${murmurs.length} in a minute`)
  const far = { x: ghost.at.x, z: ghost.at.z + GHOST.hearM + 1 }
  const quiet = []
  for (let i = 0; i < 60 * 30; i++) { ghost.update(1 / 30, 70 + i / 30, far, true); ghost.update(1 / 30, 70 + i / 30, her, false); ghost.voices(quiet) }
  check(quiet.length === 0, 'far from it, or once it is gone, it is silent', `${quiet.length}`)
  ghost.update(1 / 30, 10, her, false)
  check(!ghost.mesh.visible, 'at rest, it is gone')
  ghost.update(1 / 30, 10, her, true)
  ghost.outside()
  ghost.update(1 / 30, 10, her, true)
  check(!ghost.mesh.visible, 'and never drawn once she has left its castle')
  ghost.dispose()
}

console.log(`\n${failures === 0 ? 'all passing' : `${failures} failing`}`)
process.exit(failures === 0 ? 0 : 1)
