// Node-side gates for the villagers (src/v2/render/villagers.js, DESIGN.md §30).
//
//   node scripts/check-villagers.mjs
//
// One real village (rooms/village.js on a shipped entrance key) under a
// stand-in asset carrying the shipped leafkin's numbers: the road graph
// covers every road but the pads and every door and is one piece; a day of
// villagers with her far off never leaves the cobbles but for a gazing spot,
// goes in and out of its doors, stands, gazes at the lake and stops to talk
// in pairs, chattering by turns; two instances stepped on different frame
// times agree to the bit; a boot mid-chapter finds the village already about
// its day, silent; her feet within three metres set every villager running,
// whimpering and panting, and none calms under thirty metres.

import * as THREE from 'three'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { SEED } from '../src/v2/config.js'
import { V2Height } from '../src/v2/height/field.js'
import { RELIEF_SHIPPED } from '../src/v2/height/relief.js'
import { Layers } from '../src/v2/layers/layers.js'
import { validate } from '../src/v2/layers/doc.js'
import { buildRockBank } from '../src/props/rock-bank.js'
import { buildTextureArray } from '../src/textures.js'
import { SOUNDS } from '../src/v2/audio/ambience.js'
import { CRITTER_GLB } from '../src/v2/render/critters.js'
import { LAMP_GLB, LAMP_ORIGIN, Lamps, lampBankFrom } from '../src/v2/render/lamps.js'
import { RoomProps, propBankFrom } from '../src/v2/render/room-props.js'
import { Shell } from '../src/v2/render/shell.js'
import {
  Villagers, CALM_M, CLIPS, EXTRA, GAZE_OFF_M, GAZE_S, INSIDE_S, LOD_TIERS, PACE, STARTLE_M, TALK_M, TALK_S, WHIMPER_S, dijkstra, roadGraph,
} from '../src/v2/render/villagers.js'
import { WALK, WalkSurface } from '../src/v2/walk.js'
import { CHAPTER_S, keyHash } from '../src/sim/score.js'
import { readGlb } from '../tools/creatures/apply-rig-edit.mjs'
import { GEN_PROPS_DIR, readShippedAsset, readShippedLadder } from './lib/gen-prop-node.mjs'
import { buildVillage, rollVillage } from '../src/v2/rooms/village.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}
const swing = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a))

// --- the village ------------------------------------------------------------------
const KEY = 'hollow:160.0:-356.0'
const houseBank = propBankFrom(readShippedLadder('house-leafkin'))
const spec = rollVillage(keyHash(KEY), houseBank.bounds)
const shell = new Shell(new THREE.Scene(), buildRockBank(), buildTextureArray(), spec.shell)
const room = buildVillage({ spec, shell, house: houseBank.bounds })
const layers = Layers.deserialize(validate(room.doc))
const field = new V2Height({ heightmap: room.heightmap, layers, seed: SEED, relief: RELIEF_SHIPPED })
const roomProps = new RoomProps(new THREE.Scene(), field, { bank: houseBank, props: room.props, clearing: room.clearing })
const lampBank = lampBankFrom(readShippedAsset(path.join(GEN_PROPS_DIR, path.basename(LAMP_GLB)), { origin: LAMP_ORIGIN }))
const lamps = new Lamps(new THREE.Scene(), field, { bank: lampBank, lamps: room.lamps, seed: 1, patch: (m) => m })
const walk = new WalkSurface(field, shell, { trunkAt: () => null })
walk.addStone(roomProps)
walk.addStone(lamps)
const water = { isSubmerged: (x, z, y) => y < room.lake.y }
const doors = roomProps.doors()
const roads = room.doc.roads.filter((r) => !r.id.startsWith('pad-'))
/** The nearest a road's polyline comes to (x, z). */
const roadNear = (x, z) => {
  let best = Infinity
  for (const r of roads) {
    for (let i = 1; i < r.pts.length; i++) {
      const [ax, , az] = r.pts[i - 1], [bx, , bz] = r.pts[i]
      const dx = bx - ax, dz = bz - az, len = dx * dx + dz * dz
      const t = len > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len)) : 0
      best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z))
    }
  }
  return best
}

// --- a stand-in asset: a slab on a skeleton of a spine and two legs, the shipped clips and numbers ---------
const { json } = readGlb(new URL(`../public/${CRITTER_GLB.leafkin}`, import.meta.url))
const biped = json.scenes[json.scene ?? 0].extras.biped
function makeAsset() {
  const root = new THREE.Bone()
  root.name = 'tripo::Root'
  const spine = new THREE.Bone()
  spine.name = 'Spine'
  spine.position.set(0, 0.5, 0)
  root.add(spine)
  const bones = [root, spine]
  const legs = []
  for (const [side, sz] of [['L', 1], ['R', -1]]) {
    const hip = new THREE.Bone()
    hip.name = `Hip${side}`
    hip.position.set(0, biped.height * 0.55, sz * biped.width * 0.3)
    const knee = new THREE.Bone()
    knee.name = `Knee${side}`
    knee.position.set(biped.height * 0.1, -biped.height * 0.27, 0)
    const foot = new THREE.Bone()
    foot.name = `Foot${side}`
    foot.position.set(-biped.height * 0.1, -biped.height * 0.26, 0)
    root.add(hip)
    hip.add(knee)
    knee.add(foot)
    bones.push(hip, knee, foot)
    legs.push({ id: side, chain: [hip.name, knee.name, foot.name] })
  }
  root.updateMatrixWorld(true)
  const skeleton = new THREE.Skeleton(bones, bones.map((b) => b.matrixWorld.clone().invert()))
  const tiers = Array.from({ length: LOD_TIERS }, (_, k) => {
    const g = new THREE.BoxGeometry(biped.span, biped.height, biped.width, LOD_TIERS - k, 1, 1).translate(0, biped.height / 2, 0)
    const n = g.getAttribute('position').count
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2))
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

const make = () => new Villagers(new THREE.Scene(), water, { walk, roads: room.doc.roads, doors, lake: room.lake, seed: spec.seed, asset: makeAsset() })
const T0 = 1000
const FAR = { x: 400, y: 100, z: 400 }
const head = (feet) => ({ x: feet.x, y: feet.y + 1.6, z: feet.z })
/** Frames at `hz` from `t` for `seconds`, her feet at `feet`; `each(t)` after every frame, and the voices are dropped on the floor when there is none to hear them. Returns the time reached. */
function run(v, t, seconds, feet, each = null, hz = 60) {
  const frames = Math.round(seconds * hz)
  for (let i = 0; i < frames; i++) {
    t += 1 / hz
    v.update(feet, head(feet), t, 1 / hz)
    if (each) each(t); else v.voices([])
  }
  return t
}
const feetAt = (c) => ({ x: c.x, y: c.y, z: c.z })

// --- the graph ---------------------------------------------------------------------
console.log('\nthe graph')
{
  const g = roadGraph(room.doc.roads, doors)
  const ids = new Set(g.nodes.map((n) => n.road))
  check(roads.every((r) => ids.has(r.id)) && !g.nodes.some((n) => n.road.startsWith('pad-')), 'every road but the pads is in the graph', `${g.nodes.length} nodes over ${[...ids].join(' ')}`)
  check(g.doorNodes.length === doors.length && g.doorNodes.every((k, i) => g.nodes[k].x === doors[i].x && g.nodes[k].z === doors[i].z && g.adj[k].length >= 1), 'every door is a node on the graph')
  const { dist } = dijkstra(g, g.doorNodes[0])
  check(dist.every((d) => Number.isFinite(d)), 'the graph is one piece: every node is reached from the first door', `farthest ${Math.max(...dist).toFixed(0)} m by road`)
  let off = 0, wet = 0
  for (const n of g.nodes) {
    if (n.road !== 'door' && roadNear(n.x, n.z) > 0.6) off++
    if (field.heightAt(n.x, n.z) < room.lake.y) wet++
  }
  check(off === 0 && wet === 0, 'every node is on a road\'s centreline and on dry ground', `${off} off, ${wet} wet`)
  const v = make()
  check(v.all.length === doors.length + EXTRA && v.all.every((c) => c.hidden && c.state === 'inside'), `one villager a house and ${EXTRA} more, all indoors until stepped`, `${v.all.length}`)
  check(v.spots.every((s) => roadNear(s.x, s.z) <= GAZE_OFF_M + 0.3 && field.heightAt(s.x, s.z) >= room.lake.y), 'every gazing spot is a step off the loop on dry ground')
  check(v.bodies([]).length === 0 && v.voices([]).length === 0, 'nothing is drawn or heard before the first frame')
}

// --- a day with her far off ------------------------------------------------------------
console.log('\na day with her far off')
{
  const v = make()
  const seen = new Set()
  let strayed = 0, worst = 0, unseat = 0, vaulted = 0, badClip = 0, gazeOff = 0, hiddenVoice = 0, entries = 0, exits = 0, meetings = 0, apart = 0, gestures = 0
  const was = v.all.map(() => null)
  const voices = []
  const talkers = new Map()
  run(v, T0, 600, FAR, () => {
    const said = v.voices([])
    for (const s of said) {
      voices.push(s.sound)
      // The nearest villager to the sound: a talk beside a door stands as near one indoors as the talker.
      const who = v.all.reduce((best, c) => (Math.hypot(c.x - s.x, c.z - s.z) < Math.hypot(best.x - s.x, best.z - s.z) ? c : best))
      if (Math.hypot(who.x - s.x, who.z - s.z) >= 0.5 || who.hidden) hiddenVoice++
      if (who?.state === 'talk') talkers.set(who.id, (talkers.get(who.id) ?? 0) + 1)
    }
    v.all.forEach((c, i) => {
      seen.add(c.state)
      const prev = was[i]
      const home = v.graph.nodes[c.home]
      if (prev !== null && prev !== c.hidden) {
        if (Math.hypot(c.x - home.x, c.z - home.z) > 0.5) strayed++
        if (c.hidden) entries++; else exits++
      }
      was[i] = c.hidden
      if (c.hidden) return
      const near = roadNear(c.x, c.z)
      const atSpot = v.spots.some((s) => Math.hypot(s.x - c.x, s.z - c.z) <= GAZE_OFF_M + 0.4)
      const allowed = atSpot ? GAZE_OFF_M + 0.4 : 0.8
      if (near > allowed) { strayed++; worst = Math.max(worst, near) }
      if (v.seat(c.x, c.z) === null) unseat++
      if (c.y - field.heightAt(c.x, c.z) > WALK.reach) vaulted++
      if (c.state === 'walk' && (c.clip !== (c.runner ? 'run' : 'walk') || Math.abs(c.speed - v.asset.gait[c.clip] * c.k * c.pace) > 1e-9)) badClip++
      if ((c.state === 'stand' || c.state === 'gaze') && (c.clip !== 'idle' || c.speed !== 0)) badClip++
      if (c.state === 'talk' && (!CLIPS.includes(c.clip) || c.speed !== 0)) badClip++
      if (c.state === 'talk' && c.clip !== 'idle') gestures++
      // A second into the gaze, past the longest turn at TURN_RATE.
      if (c.state === 'gaze' && c.hold < GAZE_S[0] - 1 && Math.abs(swing(c.heading, Math.atan2(-(room.lake.z - c.z), room.lake.x - c.x))) > 0.05) gazeOff++
      if (c.state === 'talk') {
        meetings++
        const d = Math.hypot(c.x - c.partner.x, c.z - c.partner.z)
        if (d > TALK_M + 0.1 || c.partner.partner !== c) apart++
      }
    })
  })
  check(['inside', 'walk', 'stand', 'gaze', 'talk'].every((s) => seen.has(s)) && !seen.has('flee'), 'they go in and out, walk, stand, gaze and talk, and nothing frightens them', [...seen].join(' '))
  check(strayed === 0, 'nobody steps off the cobbles but for a gazing spot, and every door is crossed at its own house', `${strayed} strayed, worst ${worst.toFixed(2)} m`)
  check(unseat === 0, 'every step is on dry ground clear of the trunks')
  check(vaulted === 0, `nobody stands over ${WALK.reach} m above the ground: under a house's awning, not on it`, `${vaulted} ticks up`)
  check(entries >= 2 && exits >= v.all.length, 'houses are entered and left', `${entries} entries, ${exits} exits`)
  check(badClip === 0, 'a walker walks at its pace, a runner runs, a stander idles, a talker gestures or idles, none of them moving')
  const paces = new Set(v.all.map((c) => c.pace)), runners = v.all.filter((c) => c.runner).length
  check(paces.size === v.all.length && v.all.every((c) => c.pace >= PACE[0] && c.pace <= PACE[1]) && runners >= 1 && runners < v.all.length, 'every villager has its own pace and some, not all, run their errands', `paces ${[...paces].map((p) => p.toFixed(2)).join(' ')}, ${runners} runners`)
  check(gazeOff === 0, 'a gazer faces the lake')
  check(meetings > 0 && apart === 0, 'a talk is two, within reach of each other, each the other\'s partner', `${meetings} talk frames`)
  check(talkers.size >= 2 && [...talkers.values()].every((n) => n >= 2), 'both of a pair chatter, more than once', `${[...talkers.values()].join('/')} calls by ${talkers.size} talkers`)
  check(gestures > 0 && voices.every((s) => SOUNDS[s] !== undefined) && voices.some((s) => s.startsWith('leafkinChatter')) && !voices.includes('leafkinWhimper') && !voices.includes('panting'), 'every call is a sound the ear has, chatter among them and no whimper', `${voices.length} calls`)
  check(hiddenVoice === 0, 'nothing is heard from indoors')
  check(v.stats.talks > 0 && v.stats.startles === 0, 'the stats agree', JSON.stringify(v.stats))
}

// --- determinism and the boot --------------------------------------------------------
console.log('\ndeterminism and the boot')
{
  const a = make(), b = make()
  run(a, T0, 200, FAR, null, 60)
  run(b, T0, 200, FAR, null, 45)
  const same = a.all.every((c, i) => c.x === b.all[i].x && c.z === b.all[i].z && c.heading === b.all[i].heading && c.state === b.all[i].state && c.hidden === b.all[i].hidden)
  check(same, 'two instances stepped on different frame times agree to the bit')
  const late = make()
  late.update(FAR, head(FAR), T0 + 500, 1 / 60)
  check(late.all.some((c) => !c.hidden) && late.voices([]).length === 0, 'a boot mid-chapter finds villagers about, and hears nothing of the replay', JSON.stringify(late.stats.states))
  const chapter = make()
  const t = run(chapter, T0, CHAPTER_S + 30, FAR)
  check(chapter.all.every((c) => c.tick * (1 / 20) > t - 1), 'a chapter turn is stepped through, nobody put back', JSON.stringify(chapter.stats.states))
}

// --- her feet ------------------------------------------------------------------------
console.log('\nher feet')
{
  const v = make()
  let t = run(v, T0, 120, FAR)
  let fleers = 0, calmedUnder = 0, calmedOver = 0, whimpers = 0, pants = 0, fled = 0, homed = 0, wrongVoice = 0
  /** The sounds `c` made this frame: those nearest it, since the others go on talking and a fleer runs past them. */
  const saidBy = (c) => v.voices([]).filter((s) => {
    const by = (o) => Math.hypot(s.x - o.x, s.z - o.z)
    return by(c) < 0.5 && v.all.every((o) => o === c || o.hidden || by(o) >= by(c))
  }).map((s) => s.sound)
  for (const c of v.all) {
    if (c.hidden || c.state !== 'walk') continue
    const feet = feetAt(c)
    feet.x += 1
    t = run(v, t, 0.5, feet)
    if (c.state !== 'flee') { check(false, `a villager within ${STARTLE_M} m of her feet runs`, `${c.key} ${c.state}`); continue }
    fleers++
    const d0 = Math.hypot(c.x - feet.x, c.z - feet.z)
    let ran = 0
    const running = []
    t = run(v, t, 12, feet, () => {
      if (c.state === 'flee' && c.clip === 'run' && c.speed > 0) ran++
      for (const s of saidBy(c)) {
        if (s === 'leafkinWhimper') whimpers++; else if (s === 'panting') pants++; else wrongVoice++
        if (c.state === 'flee') running.push(s)
      }
    })
    // On the run the whimper and the panting take turns.
    if (running.some((s, i) => i > 0 && s === running[i - 1])) wrongVoice++
    if (c.hidden) homed++
    else if (Math.hypot(c.x - feet.x, c.z - feet.z) > d0 + 5) fled++
    if (!c.hidden && c.state !== 'flee' && Math.hypot(c.x - feet.x, c.z - feet.z) < CALM_M) calmedUnder++
    if (ran === 0) check(false, 'a fleer runs', `${c.key} ${c.state} ${c.clip}`)
    if (!c.hidden && c.state === 'flee') {
      const far = { x: c.x + CALM_M + 1, y: c.y, z: c.z }
      t = run(v, t, 40, far)
      if (c.state === 'flee') { check(false, `a fleer calms once she is ${CALM_M} m off`, c.state); continue }
      calmedOver++
    }
    t = run(v, t, 5, FAR)
    if (fleers >= 3) break
  }
  check(fleers >= 3, 'everyone she comes upon runs, nobody stands whimpering', `${fleers}`)
  check(calmedUnder === 0, `nobody calms with her under ${CALM_M} m`)
  check(calmedOver > 0, `and they calm once she is past it`, `${calmedOver}`)
  check(whimpers > 0 && pants > 0 && wrongVoice === 0, 'a fleer whimpers and pants by turns, and nothing else is heard', `${whimpers} whimpers, ${pants} pants, ${wrongVoice} wrong`)
  check(fled + homed > 0, 'a fleer gets away from her, or indoors', `${fled} away, ${homed} home`)
  // Passers-by within her reach are startled too, so the count is at least the ones she was put beside.
  check(v.stats.startles >= fleers, 'the stats count the startles', JSON.stringify(v.stats))
  check(WHIMPER_S[0] > 0 && TALK_S[0] < TALK_S[1] && INSIDE_S[0] < INSIDE_S[1], 'the tunables are ranges')
}

console.log(failures === 0 ? '\nall ok' : `\n${failures} failing`)
process.exit(failures === 0 ? 0 : 1)
