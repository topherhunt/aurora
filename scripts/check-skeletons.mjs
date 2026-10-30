// Node-side gates for the bone friends (src/v2/render/skeletons.js, src/v2/hideout-spot.js; design/45-bone-friends.md).
//
//   node scripts/check-skeletons.mjs
//
// Where the lost boy hides in a castle and a cave, and the skeleton's life on a stand-in body: shy at its hideout, coaxed
// and tamed with a bone, collapsing when rushed and getting up again, following her, begging for a pumpkin and taking it
// only from her hand, the boy found. What this can NOT check: how the clips look, or that the eyes sit in the sockets.

import * as THREE from 'three'
import { setPuppetMode } from '../src/v2/render/baked-puppet.js'
import { castleLayout, CASTLE } from '../src/v2/castles/layout.js'
import { roomProps } from '../src/v2/castles/furnish.js'
import { caveSpot, castleSpot, ghostSpot } from '../src/v2/hideout-spot.js'
import { CastleGhost, GHOST } from '../src/v2/render/ghost.js'
import { Skeletons, SKELETON, CLIPS, placeKey } from '../src/v2/render/skeletons.js'
import { TOWNSFOLK } from '../src/v2/render/townsfolk.js'
import { LOD_RUNGS } from '../src/v2/render/critters.js'
import { EAT, Effects, edible } from '../src/v2/eating.js'
import { Wisps, WISP } from '../src/v2/render/wisps.js'
import { Sheets } from '../src/v2/render/sheets.js'
import { Treats, doorOnRay, nightOf } from '../src/v2/treats.js'

setPuppetMode('skinned')

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

// --- the hideout spots -----------------------------------------------------------
{
  const S = CASTLE.scale
  for (const seed of [1, 2, 3, 77, 991, 4242]) {
    const lay = castleLayout(seed)
    const props = roomProps(lay)
    const spot = castleSpot(lay, props)
    const room = spot && lay.nodes.find((n) => n.id === spot.room)
    check(spot !== null && room.k === 0 && !room.unused, `castle ${seed}: the boy hides on a ground floor in use`, spot && `${room.id} ${room.sec.kind}`)
    if (spot === null) continue
    const tall = Math.max(...lay.nodes.filter((n) => n.kind === 'room' && !n.unused && n.k === 0 && (n.sec.kind === 'lookout' || n.sec.kind === 'tower')).map((n) => n.sec.floors), -1)
    check(tall < 0 || ((room.sec.kind === 'lookout' || room.sec.kind === 'tower') && room.sec.floors === tall), `castle ${seed}: at the foot of its tallest tower, never the courtyard`, `${room.sec.kind} ${room.sec.floors} of ${tall}`)
    const x0 = lay.X(room.x0) * S, x1 = lay.X(room.x0 + room.w) * S, z0 = lay.Z(room.z0) * S, z1 = lay.Z(room.z0 + room.d) * S
    check(spot.lx > x0 && spot.lx < x1 && spot.lz > z0 && spot.lz < z1, `castle ${seed}: inside its room's walls`)
    check(props.every((p) => p.k !== 0 || Math.hypot(p.x - spot.lx, p.z - spot.lz) >= Math.hypot(p.w, p.d) / 2 + 0.5), `castle ${seed}: clear of the room's furniture`)
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
function makeWorld() {
  const walk = { heightAt: () => 0, normalAt: (x, z, e, out) => out, obstacleAt: () => null }
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
  check(w.layer.list.length === 1 && !b.tame && b.state === 'hide' && b.clip === 'cower', 'the hideout\'s skeleton is shy: cowering at home')
  check(w.layer.lying.length === SKELETON.stash, `${SKELETON.stash} bones lie by it for her to feed it with`)
  check(w.layer.boy !== null && w.layer.boy.clip === 'gather' && Math.hypot(w.layer.boy.x - place.x, w.layer.boy.z - place.z) < 1.5, 'the lost boy crouches by it, playing with its bones')
  check(Math.abs(place.y - (320 + castleSpot(castleLayout(3), roomProps(castleLayout(3))).ly)) < 1e-9, 'it stands on the hideout room\'s floor, the interior\'s height over the castle')

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
  let rushX = place.x + 4.5
  run(w, 0.6, () => { rushX -= 4 * DT; return { x: rushX, y: 320, z: place.z } }, clock)
  check(b.state === 'pile' || b.state === 'rise', 'she running at a shy one collapses it into a pile', b.state)
  check(w.layer.said.some((v) => v.sound === 'skeletonCollapse'), 'it clatters down')
  check(w.layer.carriers === undefined && w.carriers.length === 0, 'with nothing to drop')
  run(w, SKELETON.pileS[1] + 1.5, far, clock)
  check(b.state === 'hide' && b.squash === 0 && Math.hypot(b.x - home.x, b.z - home.z) < 0.01, 'and reassembles, cowering where it was', b.state)
  check(w.layer.voices([]).some((v) => v.sound === 'skeletonReassemble'), 'with a rattle of putting itself together')

  // A bone held out draws it out; held at its head, it eats and is hers.
  const stand = { x: place.x + 3, y: 320, z: place.z }
  const bone = { kind: 'bone', x: stand.x - 0.4, y: 320 + 0.95, z: stand.z, by: null }
  w.lures.push(bone)
  run(w, 8, () => stand, clock)
  check(w.eaten.some((e) => e.kind === 'bone' && e.eater === 'skeleton'), 'a bone held out within reach of a shy one: it walks up and eats it from her hand')
  run(w, 1.5 + SKELETON.joyS, () => stand, clock)
  check(b.tame && w.friends.has('castle:3,4'), 'fed, it is tame, and its place is saved among her friends')
  check(b.state === 'follow' || b.state === 'fidget', 'and follows her', b.state)

  // Finding the boy.
  run(w, 3, () => ({ x: w.layer.boy.x + 1, y: 320, z: w.layer.boy.z }), clock)
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
  const S = CASTLE.scale
  for (const seed of [1, 2, 3, 77, 991, 4242]) {
    const lay = castleLayout(seed)
    const boy = castleSpot(lay, roomProps(lay))
    const g = ghostSpot(lay, boy.room)
    const room = g && lay.nodes.find((n) => n.kind === 'room' && n.k === 0 && !n.unused && lay.X(n.x0) * S < g.lx && g.lx < lay.X(n.x0 + n.w) * S && lay.Z(n.z0) * S < g.lz && g.lz < lay.Z(n.z0 + n.d) * S)
    check(g !== null && room !== undefined && room.id !== boy.room, `castle ${seed}: its ghost drifts in a ground-floor room, not the boy's`, room && `${room.sec.kind}`)
  }
  const ghost = new CastleGhost(new THREE.Scene())
  const site = { id: '3,4', seed: 3, x: 100, z: 50, yaw: 0.4 }
  ghost.into(site, 320)
  check(ghost.at !== null && Math.abs(ghost.at.y - 320 - GHOST.lift) < 1e-9, 'in its castle, it floats over the ground floor', ghost.at && `${ghost.at.y}`)
  const her = { x: ghost.at.x, z: ghost.at.z + 5 }
  for (let i = 0; i < 300; i++) ghost.update(1 / 30, i / 30, her, true)
  const fwd = new THREE.Vector3(1, 0, 0).applyEuler(ghost.mesh.rotation)
  check(ghost.mesh.visible && fwd.z > 0.99, 'shown, it turns to face her', `${fwd.x.toFixed(2)}, ${fwd.z.toFixed(2)}`)
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
