// Node-side gates for the villagers (src/v2/render/villagers.js, DESIGN.md §30).
//
//   node scripts/check-villagers.mjs
//
// One real village (rooms/village.js on a shipped entrance key) under a
// stand-in asset carrying the shipped leafkin's numbers: the road graph
// covers every road but the pads and every door and is one piece; a day of
// villagers with her far off never leaves the cobbles but for a gazing spot
// or a stool, goes in and out of its doors, stands, gazes at the lake, sits
// on the stools (never two on one, its feet clear of the disc, facing the
// fire or the lake, down and up on the sit clip's cuts) and stops to talk
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
import { HEARTH, buildHearth } from '../src/v2/render/hearth.js'
import { Stools } from '../src/v2/render/stools.js'
import {
  Villagers, CALM_M, CLIPS, EXTRA, GAZE_OFF_M, GAZE_S, INSIDE_S, LOD_TIERS, PACE, SIT, SIT_CUT, SIT_S, STARTLE_M, TALK_M, TALK_S, WHIMPER_S, dijkstra, roadGraph,
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
// The seats: the hearth's stools about the clearing's centre (its geometry alone, the way main.js reads Hearth.stools) and the room's scattered ones.
const textures = buildTextureArray()
const hearthAt = { x: room.clearing.x, z: room.clearing.z, y: field.heightAt(room.clearing.x, room.clearing.z) }
const hearth = buildHearth(buildRockBank(), spec.seed, (x, z) => field.heightAt(hearthAt.x + x, hearthAt.z + z) - hearthAt.y)
const hearthStone = {
  columnAt: (x, z, _m, out) => { let n = 0; for (const s of hearth.stools) if (Math.hypot(x - hearthAt.x - s.x, z - hearthAt.z - s.z) <= s.r && n * 2 + 1 < out.length) { out[n * 2] = hearthAt.y + s.y; out[n * 2 + 1] = hearthAt.y + s.top; n++ } return n },
  blockTopAt: (x, z) => { let top = -Infinity; for (const s of hearth.stools) if (Math.hypot(x - hearthAt.x - s.x, z - hearthAt.z - s.z) <= s.r) top = Math.max(top, hearthAt.y + s.top); return top },
}
walk.addStone(hearthStone)
const stools = new Stools(new THREE.Scene(), field, { sites: room.stools, textures, seed: spec.seed, patch: (m) => m })
walk.addStone(stools)
const seats = [...hearth.stools.map((s) => ({ x: hearthAt.x + s.x, z: hearthAt.z + s.z, top: hearthAt.y + s.top, r: s.r, lookX: hearthAt.x, lookZ: hearthAt.z })), ...stools.seats()]
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
// Where the stand-in's idle-sit holds its body over its own floor, as a fraction of its height: the shipped leafkin's seated underside (villagers.js seatY) measures 0.189. FOOT_M is how far a sitter's feet may then hang off the ground or sink into it -- the last centimetres a seated foot IK would take (design/30-leafkin.md).
const SEAT = 0.19
const FOOT_M = 0.06
function makeAsset() {
  const root = new THREE.Bone()
  root.name = 'tripoRoot'
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
    const tracks = [new THREE.QuaternionKeyframeTrack('Spine.quaternion', [0, dur], [0, 0, 0, 1, 0, 0, 0, 1])]
    // The hold lifts the whole slab a seat's height, so what the sitter is set down by is a real measurement off a real pose.
    const lift = SEAT * biped.height
    if (a.name === 'idle-sit') tracks.push(new THREE.VectorKeyframeTrack('tripoRoot.position', [0, dur], [0, lift, 0, 0, lift, 0]))
    return new THREE.AnimationClip(a.name, dur, tracks)
  })
  return { root, skeleton, tiers, clips, map: null, extras: biped, ...biped, legs }
}

const make = () => new Villagers(new THREE.Scene(), water, { walk, roads: room.doc.roads, doors, lake: room.lake, seats, seed: spec.seed, asset: makeAsset() })
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
  check(v.spots.every((s) => !seats.some((t) => Math.hypot(t.x - s.x, t.z - s.z) < t.r + SIT.round)), 'no gazing spot stands on a stool')
  check(v.seats.length === seats.length && v.seats.length >= HEARTH.stools.count[0] + room.stools.length && v.seats.every((s) => s.by === null && s.node >= 0 && Math.hypot(v.graph.nodes[s.node].x - s.x, v.graph.nodes[s.node].z - s.z) < 4), 'every seat is on the list, free, and reached from a node within four metres', `${v.seats.length} seats`)
  const ok = () => { try { return new Villagers(new THREE.Scene(), water, { walk, roads: room.doc.roads, doors, lake: room.lake, seats: [{ x: 0, z: 0 }], seed: 1, asset: makeAsset() }) } catch (e) { return e.message } }
  check(typeof ok() === 'string', 'a seat without its top, disc or look is refused')
  check(v.bodies([]).length === 0 && v.voices([]).length === 0, 'nothing is drawn or heard before the first frame')
}

// --- a day with her far off ------------------------------------------------------------
console.log('\na day with her far off')
{
  const v = make()
  const seen = new Set()
  let strayed = 0, worst = 0, unseat = 0, vaulted = 0, badClip = 0, gazeOff = 0, hiddenVoice = 0, entries = 0, exits = 0, meetings = 0, apart = 0, gestures = 0
  let sitFrames = 0, sitOff = 0, sitFar = 0, sitOn = 0, sitLow = 0, sitPerch = 0, sitClip = 0, sitAway = 0, doubled = 0, unheld = 0, phases = new Set(), satOn = new Set(), sitters = new Set()
  const was = v.all.map(() => null)
  const voices = []
  // The chapter's replay on the first frame may leave some already out of doors, their exit unseen.
  let out0 = -1
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
      if (prev === null && !c.hidden) out0++
      was[i] = c.hidden
      if (c.hidden) return
      const near = roadNear(c.x, c.z)
      const atSpot = v.spots.some((s) => Math.hypot(s.x - c.x, s.z - c.z) <= GAZE_OFF_M + 0.4)
      // On its way round to a stool and back it is as far off the road as the stool is from its node, and SIT.round wide of that.
      const seatOff = (s) => Math.hypot(s.x - v.graph.nodes[s.node].x, s.z - v.graph.nodes[s.node].z) + s.r + SIT.round + 0.5
      const atSeat = v.seats.reduce((best, s) => (Math.hypot(s.x - c.x, s.z - c.z) <= seatOff(s) ? Math.max(best, seatOff(s)) : best), 0)
      const allowed = Math.max(atSpot ? GAZE_OFF_M + 0.4 : 0, atSeat, 0.8)
      if (near > allowed) { strayed++; worst = Math.max(worst, near) }
      if (v.seat(c.x, c.z) === null) unseat++
      if (c.y - field.heightAt(c.x, c.z) > WALK.reach) vaulted++
      if (c.state === 'walk' && (c.clip !== (c.runner ? 'run' : 'walk') || Math.abs(c.speed - v.asset.gait[c.clip] * c.k * c.pace) > 1e-9)) badClip++
      if ((c.state === 'stand' || c.state === 'gaze') && (c.clip !== 'idle' || c.speed !== 0)) badClip++
      if (c.state === 'talk' && (!CLIPS.includes(c.clip) || c.speed !== 0)) badClip++
      if (c.state === 'talk' && c.clip !== 'idle') gestures++
      // A second into the gaze, past the longest turn at TURN_RATE.
      if (c.state === 'gaze' && c.hold < GAZE_S[0] - 1 && Math.abs(swing(c.heading, Math.atan2(-(room.lake.z - c.z), room.lake.x - c.x))) > 0.05) gazeOff++
      if (c.state === 'sit') {
        sitFrames++
        sitters.add(c.id)
        phases.add(c.phase)
        const s = c.seat
        if (s === null || s.by !== c) { unheld++; return }
        satOn.add(seats.indexOf(seats.find((t) => t.x === s.x && t.z === s.z)))
        // Its feet a `SIT.back` of the wheelbase short of the stool's centre toward its look, outside the disc, on the ground and never lifted onto the stool.
        const d = Math.hypot(c.x - s.x, c.z - s.z)
        if (d <= s.r) sitOn++
        if (d > Math.max(SIT.back * v.asset.wheelbase * c.k, s.r + SIT.clear) + 0.4) sitFar++
        // Set down by its seated underside (seatY): on the stool's top through the hold, eased onto it over the cuts and never past either end of that ease.
        const ground = field.heightAt(c.x, c.z), onStool = s.top - v.sitY * c.k
        if (c.phase === 'hold' && Math.abs(c.y - onStool) > 1e-9) sitPerch++
        if (c.phase === 'turn' && Math.abs(c.y - ground) > 1e-9) sitPerch++
        if (c.y < Math.min(ground, onStool) - 1e-6 || c.y > Math.max(ground, onStool) + 1e-6) sitPerch++
        if (c.phase === 'hold') sitLow = Math.max(sitLow, Math.abs(onStool - ground))
        if (c.phase !== 'turn' && Math.abs(swing(c.heading, Math.atan2(-(s.lookZ - c.z), s.lookX - c.x))) > 0.05) sitAway++
        const want = { turn: 'idle', down: 'sit', hold: 'idle-sit', up: 'sit' }[c.phase]
        if (c.clip !== want || c.speed !== 0 || (c.phase === 'up' ? c.from !== SIT_CUT[1] : c.from !== -1)) sitClip++
        if (c.phase === 'down' && Math.abs(c.dur * c.pace - SIT_CUT[0]) > 1e-9) sitClip++
        if (c.phase === 'up' && Math.abs(c.dur * c.pace - (v.durations.sit - SIT_CUT[1])) > 1e-9) sitClip++
        if (c.phase === 'hold' && c.hold > SIT_S[1]) sitClip++
        for (const o of v.all) if (o !== c && o.seat === s) doubled++
      } else if (c.seat !== null && c.state !== 'walk') sitOff++
      if (c.state === 'talk') {
        meetings++
        const d = Math.hypot(c.x - c.partner.x, c.z - c.partner.z)
        if (d > TALK_M + 0.1 || c.partner.partner !== c) apart++
      }
    })
  })
  check(['inside', 'walk', 'stand', 'gaze', 'sit', 'talk'].every((s) => seen.has(s)) && !seen.has('flee'), 'they go in and out, walk, stand, gaze, sit and talk, and nothing frightens them', [...seen].join(' '))
  check(strayed === 0, 'nobody steps off the cobbles but for a gazing spot or a stool, and every door is crossed at its own house', `${strayed} strayed, worst ${worst.toFixed(2)} m`)
  check(sitFrames > 0 && sitters.size >= 2 && ['turn', 'down', 'hold', 'up'].every((p) => phases.has(p)), 'more than one sits, turning, sitting down, holding and rising', `${sitters.size} sitters over ${sitFrames} frames, phases ${[...phases].join(' ')}`)
  check(satOn.size >= 2, 'more than one stool is sat on', `${satOn.size} of ${seats.length}`)
  check(unheld === 0 && doubled === 0 && sitOff === 0, 'a sitter holds its stool, nobody else does, and a seat is claimed only by a walker on its way or a sitter', `${unheld} unheld, ${doubled} doubled, ${sitOff} held idle`)
  check(sitOn === 0 && sitFar === 0, 'a sitter\'s feet stand just off its stool, never on it', `${sitOn} on, ${sitFar} far`)
  check(sitPerch === 0, 'a sitter is set down by its seated underside: on the stool\'s top through the hold, on the ground as it turns, and eased between over the cuts', `${sitPerch}`)
  check(sitLow <= FOOT_M, 'a stool is cut close enough to a leafkin\'s seat that a sitter\'s feet keep the ground', `${sitLow.toFixed(3)} m at worst`)
  check(sitAway === 0, 'a sitter faces the fire or the lake once turned', `${sitAway}`)
  check(sitClip === 0, 'a sitter idles while it turns, sits on the sit clip\'s first cut, holds on idle-sit and rises on the clip from its second cut, still', `${sitClip}`)
  check(v.seats.every((s) => s.by === null || (!s.by.hidden && (s.by.state === 'sit' || s.by.state === 'walk'))), 'at the day\'s end every seat is free or held by one on it or on its way')
  check(unseat === 0, 'every step is on dry ground clear of the trunks')
  check(vaulted === 0, `nobody stands over ${WALK.reach} m above the ground: under a house's awning, not on it`, `${vaulted} ticks up`)
  check(entries >= 2 && exits + out0 + 1 >= v.all.length, 'houses are entered and left', `${entries} entries, ${exits} exits, ${out0 + 1} out at the first frame`)
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
  // Where each villager stood at the end of the last frame: a call is placed where its caller was when it made it, and a runner has moved on by the time the ear drains it.
  const was = new Map()
  const mark = () => { for (const o of v.all) was.set(o, { x: o.x, z: o.z }) }
  /** The sounds `c` made this frame: those nearest it now or a frame ago, since the others go on talking and a fleer runs within centimetres of them. */
  const saidBy = (c) => v.voices([]).filter((s) => {
    const by = (o) => { const w = was.get(o) ?? o; return Math.min(Math.hypot(s.x - o.x, s.z - o.z), Math.hypot(s.x - w.x, s.z - w.z)) }
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
    mark()
    t = run(v, t, 12, feet, () => {
      if (c.state === 'flee' && c.clip === 'run' && c.speed > 0) ran++
      for (const s of saidBy(c)) {
        if (s === 'leafkinWhimper') whimpers++; else if (s === 'panting') pants++; else wrongVoice++
        if (c.state === 'flee') running.push(s)
      }
      mark()
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
