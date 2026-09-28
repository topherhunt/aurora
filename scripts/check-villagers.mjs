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
  Villagers, AWAY_S, CLIPS, DOOR_FADE_S, EXTRA, HOMING_S, MOUTH_M, NODE_M, SPACE_M, GAZE_OFF_M, GAZE_S, INSIDE_S, LOD_TIERS, PACE, SIT, SIT_CUT, SIT_S, STARTLE_M, HIDE_S, FIND_M, TALK_M, TALK_S, WHIMPER_S, dijkstra, roadGraph,
} from '../src/v2/render/villagers.js'
import { WALK, WalkSurface } from '../src/v2/walk.js'
import { LEAD_TICKS, popM } from '../src/v2/render/net-ease.js'
import { CHAPTER_S, chapterOf, keyHash } from '../src/sim/score.js'
import { CARRY_MAX } from '../src/v2/hands.js'
import { STARTLE_S } from '../src/v2/render/leafkin.js'
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
/** The nearest the segment a-b comes to (x, z). */
const segNear = (x, z, a, b) => {
  const dx = b.x - a.x, dz = b.z - a.z, len = dx * dx + dz * dz
  const t = len > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len)) : 0
  return Math.hypot(a.x + dx * t - x, a.z + dz * t - z)
}
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

const make = (hands = null) => new Villagers(new THREE.Scene(), water, { walk, roads: room.doc.roads, doors, lake: room.lake, seats, seed: spec.seed, asset: makeAsset(), exit: room.exit, hands, mushrooms: hands && { record: () => ({ kind: 'mushroom' }) } })
/** A stand-in for hands.js: carriers that log what each is asked, and a ground of loose things. */
function fakeHands() {
  const h = { loose: [], tag: null, carriers: 0, lifted: [], log: [] }
  h.carry = (owner) => {
    h.carriers++
    let n = 0
    const say = (what) => () => { h.log.push([what, owner]) }
    return { count: () => n, add: () => { n++ }, clear: () => { n = 0 }, place: say('place'), grip: say('grip'), scatter: say('scatter'), release: () => { h.carriers--; h.log.push(['release', owner]) } }
  }
  h.lift = (item) => { h.loose.splice(h.loose.indexOf(item), 1); h.lifted.push(item) }
  return h
}
const T0 = 1000
const FAR = { x: 400, y: 100, z: 400 }
// The longest a walker may go without headway: a brush past someone, not a queue behind them.
const JAM_S = 1
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
  let overlaps = 0, closest = Infinity, blocked = 0
  let strayed = 0, worst = 0, unseat = 0, vaulted = 0, badClip = 0, gazeOff = 0, hiddenVoice = 0, entries = 0, exits = 0, stoop = 0, doorCalls = 0, doorOff = 0, meetings = 0, apart = 0, gestures = 0
  let sitFrames = 0, sitOff = 0, sitFar = 0, sitOn = 0, sitLow = 0, sitPerch = 0, sitClip = 0, sitAway = 0, doubled = 0, unheld = 0, phases = new Set(), satOn = new Set(), sitters = new Set()
  const was = v.all.map(() => null)
  const voices = []
  // The chapter's replay on the first frame may leave some already out of doors, their exit unseen.
  let out0 = -1
  const talkers = new Map()
  run(v, T0, 600, FAR, () => {
    const said = v.voices([])
    for (const s of said) {
      // A door is heard from the sill of the one going in or out of it, by its own rule.
      if (s.sound === 'door') {
        doorCalls++
        if (s.rule !== 'door' || !v.all.some((c) => Math.hypot(v.graph.nodes[c.home].sill.x - s.x, v.graph.nodes[c.home].sill.z - s.z) < 0.05)) doorOff++
        continue
      }
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
        if (Math.hypot(c.x - home.sill.x, c.z - home.sill.z) > 0.5) strayed++
        if (c.hidden) entries++; else exits++
        // Through the door, it stands on the landing: at least half the steps' rise above the road at the door.
        const road = walk.heightAt(home.x, home.z, -Infinity)
        if (c.y - road < (walk.heightAt(home.sill.x, home.sill.z, road) - road) / 2) stoop++
      }
      if (prev === null && !c.hidden) out0++
      was[i] = c.hidden
      if (c.hidden) return
      const near = roadNear(c.x, c.z)
      const atSpot = v.spots.some((s) => Math.hypot(s.x - c.x, s.z - c.z) <= GAZE_OFF_M + 0.4)
      // On its way round to a stool and back it is as far off the road as the stool is from its node, and SIT.round wide of that.
      const seatOff = (s) => Math.hypot(s.x - v.graph.nodes[s.node].x, s.z - v.graph.nodes[s.node].z) + s.r + SIT.round + 0.5
      const atSeat = v.seats.reduce((best, s) => (Math.hypot(s.x - c.x, s.z - c.z) <= seatOff(s) ? Math.max(best, seatOff(s)) : best), 0)
      // Up the steps of its own door, it is on the way from the door's node to its sill.
      const onSteps = segNear(c.x, c.z, home, home.sill) <= 0.4
      const allowed = onSteps ? Infinity : Math.max(atSpot ? GAZE_OFF_M + 0.4 : 0, atSeat, 0.8)
      if (near > allowed) { strayed++; worst = Math.max(worst, near) }
      for (const o of v.all) {
        if (o.id <= c.id || o.hidden) continue
        const d = Math.hypot(o.x - c.x, o.z - c.z)
        closest = Math.min(closest, d)
        if (d < SPACE_M * (c.size + o.size) / 2 - 1e-6) overlaps++
      }
      // Held up: no headway with someone within a metre (alone, it is only turning).
      if (c.state === 'walk' && v.all.some((o) => o !== c && !o.hidden && Math.hypot(o.x - c.x, o.z - c.z) < 1)) blocked = Math.max(blocked, c.stall)
      if (v.seat(c.x, c.z) === null) unseat++
      if (c.y - field.heightAt(c.x, c.z) > WALK.reach) vaulted++
      if (c.state === 'walk' && (c.clip !== (c.runner || v.homing || c.trip !== '' || c.then === 'take' ? 'run' : 'walk') || Math.abs(c.speed - v.asset.gait[c.clip] * c.k * c.pace) > 1e-9)) badClip++
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
  check(overlaps === 0, `nobody walks through or stands inside anybody: every two keep ${SPACE_M} m between their centres`, `${overlaps} frames overlapped, closest ${closest.toFixed(2)} m`)
  check(blocked < JAM_S, `nobody is held up behind anybody: no walker goes ${JAM_S} s without headway`, `${blocked.toFixed(2)} s at worst`)
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
  check(unseat === 0, 'every step is on dry ground')
  check(vaulted === 0, `nobody stands over ${WALK.reach} m above the ground: under a house's awning, not on it`, `${vaulted} ticks up`)
  check(entries >= 2 && exits + out0 + 1 >= v.all.length, 'houses are entered and left', `${entries} entries, ${exits} exits, ${out0 + 1} out at the first frame`)
  check(stoop === 0, 'each goes in and comes out at the top of its steps, not at their foot', `${stoop} at the foot`)
  check(badClip === 0, 'a walker walks at its pace, a runner, one homing or one foraging runs, a stander idles, a talker gestures or idles, none of them moving')
  const paces = new Set(v.all.map((c) => c.pace)), runners = v.all.filter((c) => c.runner).length
  check(paces.size === v.all.length && v.all.every((c) => c.pace >= PACE[0] && c.pace <= PACE[1]) && runners >= 1 && runners < v.all.length, 'every villager has its own pace and some, not all, run their errands', `paces ${[...paces].map((p) => p.toFixed(2)).join(' ')}, ${runners} runners`)
  check(gazeOff === 0, 'a gazer faces the lake')
  check(meetings > 0 && apart === 0, 'a talk is two, within reach of each other, each the other\'s partner', `${meetings} talk frames`)
  check(talkers.size >= 2 && [...talkers.values()].every((n) => n >= 2), 'both of a pair chatter, more than once', `${[...talkers.values()].join('/')} calls by ${talkers.size} talkers`)
  check(gestures > 0 && voices.every((s) => SOUNDS[s] !== undefined) && voices.some((s) => s.startsWith('leafkinChatter')) && !voices.includes('leafkinWhimper') && !voices.includes('panting'), 'every call is a sound the ear has, chatter among them and no whimper', `${voices.length} calls`)
  check(hiddenVoice === 0, 'nothing is heard from indoors')
  check(doorCalls === entries + exits && doorOff === 0, 'a door is heard once as each goes in or comes out, from its sill, on the door rule', `${doorCalls} doors for ${entries + exits} crossings, ${doorOff} elsewhere`)
  check(v.stats.talks > 0 && v.stats.startles === 0, 'the stats agree', JSON.stringify(v.stats))
}

// --- in each other's way -------------------------------------------------------------------
console.log('\nin each other\'s way')
{
  /** A village with everyone kept indoors but `walkers` (each `[from, to]` nodes) and `standers` (each `[x, z]`), run `limit` s: when each walker first stands at its end, and the longest any went without headway before it. */
  const stage = (walkers, standers, limit) => {
    const v = make()
    v.update(FAR, head(FAR), T0, 1 / 60)
    for (const c of v.all) c.hold = 1e9
    const out = (c, x, z) => { c.hidden = false; c.x = c.px = x; c.z = c.pz = z; c.y = c.py = walk.heightAt(x, z); c.talked = 1e9 }
    const ws = walkers.map(([a, b], i) => { const c = v.all[i], n = v.graph.nodes[a]; out(c, n.x, n.z); c.at = a; v._go(c, b, 'stand'); return c })
    standers.forEach(([x, z], i) => { const c = v.all[walkers.length + i]; out(c, x, z); c.state = 'stand' })
    let worst = 0, overlap = 0
    const at = ws.map(() => null)
    run(v, T0, limit, FAR, (t) => {
      ws.forEach((c, k) => { if (at[k] === null && c.state === 'stand') at[k] = t - T0; if (at[k] === null) worst = Math.max(worst, c.stall) })
      for (const c of v.all) for (const o of v.all) if (o.id > c.id && !c.hidden && !o.hidden && Math.hypot(o.x - c.x, o.z - c.z) < v._space(c, o) - 1e-6) overlap++
    })
    return { arrived: at.every((a) => a !== null), worst, overlap, at }
  }
  // Eight nodes of one road, consecutive and linked: a straight stretch 12 m long.
  const g = roadGraph(room.doc.roads, doors)
  const i = g.nodes.findIndex((n, k) => Array.from({ length: 8 }, (_, j) => g.nodes[k + j + 1]?.road === n.road && g.adj[k + j].includes(k + j + 1)).every(Boolean))
  const [ax, az, bx, bz] = [g.nodes[i + 3].x, g.nodes[i + 3].z, g.nodes[i + 5].x, g.nodes[i + 5].z]
  const L = Math.hypot(bx - ax, bz - az), px = -(bz - az) / L, pz = (bx - ax) / L, m = g.nodes[i + 4]
  const head0 = stage([[i, i + 8], [i + 8, i]], [], 30)
  check(head0.arrived && head0.worst < JAM_S && head0.overlap === 0, `two meeting head on along a road slip past each other, never stalled ${JAM_S} s`, `${head0.worst.toFixed(2)} s at worst, ${head0.overlap} overlaps, there at ${head0.at.map((a) => a?.toFixed(1)).join('/')} s`)
  const pair = stage([[i, i + 8]], [[m.x + px * 0.45, m.z + pz * 0.45], [m.x - px * 0.45, m.z - pz * 0.45]], 30)
  check(pair.arrived && pair.worst < JAM_S && pair.overlap === 0, `a walker slips between two standing across the road`, `${pair.worst.toFixed(2)} s at worst, ${pair.overlap} overlaps, there at ${pair.at.map((a) => a?.toFixed(1)).join('/')} s`)
}

// --- through the door ----------------------------------------------------------------
console.log('\nthrough the door')
{
  // One villager sent home from its door node with her 6 m off, the rest kept indoors.
  const v = make()
  v.update(FAR, head(FAR), T0, 1 / 60)
  for (const c of v.all) c.hold = 1e9
  const c = v.all[0], door = v.graph.nodes[c.home]
  c.hidden = false; c.x = c.px = door.x; c.z = c.pz = door.z; c.talked = 1e9; c.at = c.home
  v._go(c, c.home, 'enter')
  const feet = { x: door.x + 6, y: walk.heightAt(door.x + 6, door.z), z: door.z }
  let hidAt = null, goneAt = null, drawnAt = null
  run(v, T0, 10, feet, (t) => {
    if (hidAt === null && c.hidden) { hidAt = t; drawnAt = c.puppet?.meshes.some((m) => m.visible) ?? false }
    if (hidAt !== null && goneAt === null && !c.puppet) goneAt = t
  })
  const took = goneAt - hidAt
  check(hidAt !== null && drawnAt && goneAt !== null && took >= DOOR_FADE_S - 0.03 && took <= DOOR_FADE_S + 0.03, `through its door it dithers out over DOOR_FADE_S ${DOOR_FADE_S} s, not at once`, `${hidAt === null ? 'never in' : `drawn ${drawnAt}, gone ${took.toFixed(3)} s after`}`)
}

// --- the forage trip -----------------------------------------------------------------
console.log('\nthe forage trip')
{
  // The first chapter from T0 that rolls a forager, stepped from its start.
  let start = chapterOf(T0, make().key).start, v = null
  for (let k = 0; k < 20 && (v === null || v.forager < 0); k++, start += CHAPTER_S) {
    v = make()
    v.update(FAR, head(FAR), start + 0.01, 1 / 60)
  }
  check(v.forager >= 0, 'some chapter sends a villager out foraging', `villager ${v.forager}, chapter at ${start - CHAPTER_S} s`)
  start -= CHAPTER_S
  v = make()
  v.update(FAR, head(FAR), start + 0.01, 1 / 60)
  const others = v.all.length - 1
  const f = v.all[v.forager]
  let leftAt = null, backAt = null, bundle = null, mouthOff = Infinity, homingBundle = null, doorsAtMouth = 0, overheard = 0, called = 0
  const squeals = new Map(), took = new Set(), ate = new Set(), wrongGift = []
  let wasFeast = new Set()
  run(v, start + 0.01, CHAPTER_S - 1, FAR, () => {
    if (f.state === 'away' && leftAt === null) { leftAt = v.tick / 20; mouthOff = Math.hypot(f.x - v.mouth.x, f.z - v.mouth.z) }
    if (f.trip === 'back' && backAt === null) { backAt = v.tick / 20; bundle = f.bundle }
    if (v.homing && homingBundle === null) homingBundle = f.bundle
    for (const o of v.all) if (o.partner === f && o.then === 'take') called = Math.max(called, 1)
    for (const call of v.voices([])) {
      if (call.sound === 'door' && Math.hypot(call.x - v.mouth.x, call.z - v.mouth.z) < 3) doorsAtMouth++
      if (call.sound !== 'leafkinSqueal') continue
      // The nearest drawn body, which may have stepped on since it called.
      const o = v.all.filter((c) => !c.hidden).sort((a, b) => Math.hypot(a.x - call.x, a.z - call.z) - Math.hypot(b.x - call.x, b.z - call.z))[0]
      if (!o || Math.hypot(o.x - call.x, o.z - call.z) > 0.3) { overheard++; continue }
      squeals.set(o.id, (squeals.get(o.id) ?? 0) + 1)
    }
    for (const o of v.all) {
      if (o.feast && !wasFeast.has(o.id)) { took.add(o.id); if (o === f || o.state !== 'talk' || o.partner !== f) wrongGift.push(o.id) }
      if (o.feast && o.state === 'inside') ate.add(o.id)
    }
    wasFeast = new Set(v.all.filter((o) => o.feast).map((o) => o.id))
  })
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
  check(leftAt !== null && leftAt - start < CHAPTER_S / 3, 'the forager goes out early in its chapter', `gone at ${leftAt === null ? '-' : (leftAt - start).toFixed(0)} s`)
  check(mouthOff <= NODE_M + 0.1 && dist(v.mouth, room.exit) <= MOUTH_M + 1e-6 && doorsAtMouth === 0, 'it is gone at the exit mouth, and no door is heard there', `${mouthOff.toFixed(2)} m off the mouth, ${doorsAtMouth} doors`)
  check(backAt !== null && backAt - leftAt >= AWAY_S[0] - 0.1 && backAt - leftAt <= AWAY_S[1] + 0.1, 'and back AWAY_S later, about five minutes', `back after ${backAt === null ? '-' : (backAt - leftAt).toFixed(0)} s`)
  check(bundle === Math.min(CARRY_MAX, others), 'with a mushroom for each of the others, as many as its arms hold', `${bundle}`)
  check(v.gifts === took.size && took.size >= 1 && wrongGift.length === 0 && !took.has(f.id), 'every mushroom given is taken by another, in a talk with the giver', `${v.gifts} given to ${[...took].join(' ')}, ${wrongGift.length} wrong`)
  check(homingBundle === 0, 'the bundle is all given out before they make for home', `${homingBundle} left at homing, ${called ? 'some' : 'none'} called`)
  check([...took].every((id) => ate.has(id)), 'each who took one goes home with it to eat', `${ate.size} of ${took.size} home`)
  check([...took].every((id) => (squeals.get(id) ?? 0) >= 2) && overheard === 0, 'each who took one squealed at the sight of it and again at the gift, from where it stood', `${[...squeals].map(([id, n]) => `${id}:${n}`).join(' ')}, ${overheard} from nobody`)
  check(v.stats.states.away === 0 && v.stats.states.give === 0 && v.all.every((c) => c.partner === null || c.state === 'talk' || c.then === 'take'), 'the day ends with nobody away or waiting, and nobody bound to a giver', JSON.stringify(v.stats.states))

  // A client booted mid-trip lands where one stepped through it is.
  const mid = backAt + 20
  const a = make(), b = make()
  run(a, start + 0.01, mid - start, FAR)
  b.update(FAR, head(FAR), mid, 1 / 60)
  run(b, mid, 0, FAR)
  check(a.tick === b.tick && a.all.every((c, i) => c.x === b.all[i].x && c.z === b.all[i].z && c.bundle === b.all[i].bundle && c.state === b.all[i].state), 'a boot mid-trip lands where the room is', `${a.all[f.id].state} with ${a.all[f.id].bundle}`)
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
  check(chapter.tick / 20 > t - 0.1, 'a chapter turn is stepped through', JSON.stringify(chapter.stats.states))
  check(chapter.stats.popped <= 1, `the turn finds them indoors: HOMING_S before it they make for their doors`, `${chapter.stats.popped} still out`)
}

// --- her feet ------------------------------------------------------------------------
console.log('\nher feet')
{
  const v = make()
  let t = run(v, T0, 120, FAR)
  let fleers = 0, whimpers = 0, pants = 0, wrongVoice = 0, hidden = 0, hideOff = 0, out = 0, outFleeing = 0
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
    let ran = 0, hidFor = null
    const running = []
    mark()
    t = run(v, t, 60, feet, () => {
      if (c.state === 'flee' && c.clip === 'run' && c.speed > 0) ran++
      if (hidFor === null && c.state === 'inside') hidFor = c.hold
      for (const s of saidBy(c)) {
        if (s === 'leafkinWhimper') whimpers++; else if (s === 'panting') pants++; else if (s !== 'door') wrongVoice++
        if (c.state === 'flee') running.push(s)
      }
      mark()
    })
    // On the run the whimper and the panting take turns.
    if (running.some((s, i) => i > 0 && s === running[i - 1])) wrongVoice++
    if (ran === 0) check(false, 'a fleer runs', `${c.key} ${c.state} ${c.clip}`)
    if (hidFor !== null) { hidden++; if (hidFor < HIDE_S[0] - 60 || hidFor > HIDE_S[1]) hideOff++ }
    // Out again, calm, though she still stands where it fled her.
    t = run(v, t, HIDE_S[1], feet, () => { if (!c.hidden && out === hidden - 1 && hidFor !== null) { out++; if (c.state === 'flee') outFleeing++ } v.voices([]) })
    if (fleers >= 3) break
  }
  check(fleers >= 3, 'everyone she comes upon runs, nobody stands whimpering', `${fleers}`)
  check(hidden === fleers && hideOff === 0, 'a fleer runs into its own house and hides there HIDE_S, two to five minutes', `${hidden} of ${fleers} in, ${hideOff} off the range`)
  check(out === hidden && outFleeing === 0, 'and comes out again calm', `${out} out, ${outFleeing} still fleeing`)
  check(whimpers > 0 && pants > 0 && wrongVoice === 0, 'a fleer whimpers and pants by turns, and nothing else is heard', `${whimpers} whimpers, ${pants} pants, ${wrongVoice} wrong`)
  // Passers-by within her reach are startled too, so the count is at least the ones she was put beside.
  check(v.stats.startles >= fleers, 'the stats count the startles', JSON.stringify(v.stats))
  check(WHIMPER_S[0] > 0 && TALK_S[0] < TALK_S[1] && INSIDE_S[0] < INSIDE_S[1], 'the tunables are ranges')
}

// --- a carrier startled --------------------------------------------------------------
console.log('\na carrier startled')
{
  const hands = fakeHands()
  const v = make(hands)
  let t = run(v, T0, 120, FAR)
  const c = v.all.find((o) => !o.hidden && o.state === 'walk')
  c.feast = true
  t = run(v, t, 0.2, { ...feetAt(c), x: c.x + 5 })
  const held = hands.log.some(([k, o]) => k === 'place' && o === c.key)
  const feet = { ...feetAt(c), x: c.x + 1 }
  const states = [], sounds = []
  t = run(v, t, 60, feet, () => {
    if (states.at(-1) !== c.state) states.push(c.state)
    for (const s of v.voices([])) if (Math.hypot(s.x - c.x, s.z - c.z) < 0.5) sounds.push(s.sound)
  })
  const recoil = states.indexOf('startle')
  check(held && recoil >= 0 && states[recoil + 1] === 'flee' && states.at(-1) === 'inside', 'one carrying a mushroom recoils where it stands, then runs home and hides', states.join(' > '))
  check(hands.log.some(([k, o]) => k === 'scatter' && o === c.key) && !c.feast && hands.carriers === 0, 'and drops what it carried', JSON.stringify(hands.log.filter(([k]) => k !== 'place')))
  check(sounds[0] === 'leafkinScream' && sounds.includes('leafkinWhimper'), 'it screams, then whimpers on the run', sounds.slice(0, 6).join(' '))
  check(STARTLE_S > 0 && c.hold >= HIDE_S[0] - 60, 'hidden for HIDE_S', `${c.hold.toFixed(0)} s left`)
}

// --- a mushroom found -----------------------------------------------------------------
console.log('\na mushroom found')
{
  const hands = fakeHands()
  const v = make(hands)
  let t = run(v, T0, 120, FAR)
  const c = v.all.find((o) => !o.hidden && o.state === 'walk')
  const n = v.graph.nodes[c.at]
  for (const dx of [0.5, 1]) hands.loose.push({ rec: { kind: 'mushroom' }, x: n.x + dx, y: walk.heightAt(n.x + dx, n.z) + 0.05, z: n.z, state: 'still', netId: null })
  let finder = null, seenM = null, picks = 0, squeals = 0, liftedAt = null, home = false
  t = run(v, t, 60, FAR, () => {
    if (finder === null) {
      finder = v.all.find((o) => o.then === 'pick') ?? null
      if (finder !== null) seenM = Math.hypot(finder.x - n.x, finder.z - n.z)
    }
    if (finder !== null) {
      if (finder.state === 'pick' && finder.clip === 'gather' && picks === 0) picks++
      if (liftedAt === null && hands.lifted.length > 0) liftedAt = finder.state
      if (finder.state === 'inside' && finder.feast) home = true
    }
    for (const s of v.voices([])) if (finder && s.sound === 'leafkinSqueal' && Math.hypot(s.x - finder.x, s.z - finder.z) < 0.5) squeals++
  })
  const finds = [...v.log.values()].flat().filter((e) => e.kind === 'find')
  const named = finds.flatMap((e) => e.ids)
  check(finder !== null && seenM < FIND_M + 1, 'a leafkin near a mushroom on the ground goes for it', `${finds.length} finds, seen from ${seenM?.toFixed(1)} m`)
  check(picks === 1 && liftedAt === 'pick' && home, 'it gathers it up, and runs home with it to eat', `lifted in ${liftedAt}, home ${home}`)
  check(squeals >= 2, 'squealing at the sight of it and as it takes it', `${squeals}`)
  check(new Set(named).size === named.length && hands.lifted.length === finds.length, 'each takes one, and goes after no other', `${finds.length} finds of ${named.join(' ')}, ${hands.lifted.length} lifted`)
}

// --- the room ------------------------------------------------------------------------
console.log('\nthe room')
{
  // Two clients of one room on their own frame rates, each one's startles reaching the other `lag` seconds late, stamped with the sender the way the relay does.
  const pair = (lag) => {
    const sides = [{ v: make(), id: 'a', hz: 60, feet: FAR }, { v: make(), id: 'b', hz: 45, feet: FAR }]
    const wire = []
    const step = (t) => {
      for (const s of sides) {
        s.v.update(s.feet, head(s.feet), t, 1 / s.hz)
        s.v.voices([])
        for (const a of s.v.pending([])) wire.push({ at: t + lag, to: sides.find((o) => o !== s).v, a: [...a.slice(0, 8), s.id, ...a.slice(9)] })
      }
      for (let i = wire.length - 1; i >= 0; i--) if (wire[i].at <= t) { wire[i].to.apply(wire[i].a); wire.splice(i, 1) }
    }
    return { sides, wire, step }
  }
  const same = (a, b) => a.all.every((c, i) => { const o = b.all[i]; return c.x === o.x && c.z === o.z && c.heading === o.heading && c.state === o.state && c.hidden === o.hidden && c.then === o.then && c.rs === o.rs })
  const run2 = (p, t, seconds) => { for (let i = 0; i < Math.round(seconds * 60); i++) { t += 1 / 60; p.step(t) } return t }
  const walker = (v) => v.all.find((c) => !c.hidden && c.state === 'walk')

  const p = pair(0.3)
  const [A, B] = p.sides
  let t = run2(p, T0, 120)
  const c = walker(A.v)
  A.feet = { ...feetAt(c), x: c.x + 1 }
  t = run2(p, t, 3)
  // Run, or already home through its door.
  const ran = [A, B].every((S) => S.v.all[c.id].state === 'flee' || S.v.all[c.id].state === 'inside')
  t = run2(p, t, 20)
  A.feet = FAR
  t = run2(p, t, 5)
  check(ran && same(A.v, B.v), 'her startle reaches the other client late, which rolls back to before it, and both see the villager run the same run', `rewinds ${B.v.stats.rewinds}, startles ${A.v.stats.startles}/${B.v.stats.startles}`)
  check(B.v.stats.rewinds > 0 && A.v.stats.rewinds === 0, 'only the client that heard it late rolled back')
  check(B.v.stats.jumps === 0 && A.v.stats.jumps === 0, 'and the rollback is eased off, never drawn as a jump', `${B.v.stats.maxRewind} ticks rewound`)
  const d = walker(B.v)
  B.feet = { ...feetAt(d), x: d.x + 1 }
  t = run2(p, t, 3)
  B.feet = FAR
  t = run2(p, t, 30)
  check([...A.v.log.values()].flat().some((e) => e.by === 'b' && e.ids.includes(d.id)) && same(A.v, B.v), 'and hers the same the other way', `rewinds ${A.v.stats.rewinds}`)

  const O = { x: 0, y: 0, z: 0 }
  check(popM({ x: 0, y: 3, z: 0 }, 0, 0, 0, 1 / 60) > 0 && popM({ x: 0.1, y: 0, z: 0 }, 0, 0, 0, 1 / 60) === 0 && popM({ x: 3, y: 0, z: 0 }, 0, 0, 0, 0.5) === 0 && popM(O, 0, 0, 0, 1 / 60) === 0, 'a body drawn 3 m up onto a roof in a frame is a pop; a run\'s step, or a half-second hitch\'s 3 m, is not')

  // Her startle is raised LEAD_TICKS ahead: heard sooner than that, nobody rolls back; heard 1.5 s late, as off a clock that far out, the villager slides onto its run.
  for (const [lag, rewinds] of [[0.1, false], [1.5, true]]) {
    const q = pair(lag)
    const [C, D] = q.sides
    let u = run2(q, T0, 120)
    const e = walker(C.v)
    C.feet = { ...feetAt(e), x: e.x + 1 }
    u = run2(q, u, 3)
    C.feet = FAR
    u = run2(q, u, 10)
    const ok = rewinds ? D.v.stats.rewinds > 0 : D.v.stats.rewinds === 0
    check(ok && D.v.stats.jumps === 0 && same(C.v, D.v), rewinds ? `heard ${lag} s late it is rolled back and drawn without a jump` : `heard ${lag} s late, inside the ${LEAD_TICKS}-tick lead, it is never rolled back`, `${D.v.stats.rewinds} rewinds of up to ${D.v.stats.maxRewind} ticks, ${D.v.stats.jumps} jumps`)
  }

  // A client arriving now hears the room's startles on the welcome, before its first frame.
  const log = [...A.v.log.values()].flat().map((e) => [e.key, e.tick / 20, e.fx, e.fy, e.fz, 0, 0, e.kind, e.by ?? 'a', ...e.ids])
  const late = make()
  for (const a of log) late.apply(a)
  late.update(FAR, head(FAR), t, 1 / 60)
  check(log.length >= 2 && same(late, A.v), 'a client arriving mid-chapter with the room\'s startles lands where the room is', `${log.length} startles`)
  const deaf = make()
  deaf.update(FAR, head(FAR), t, 1 / 60)
  check(!same(deaf, A.v), 'and one without them does not: the startles are what it needed')

  // A startle heard past every state kept is stepped again from the chapter's start.
  const q = pair(40)
  const [C, D] = q.sides
  let u = run2(q, T0, 120)
  const e = walker(C.v)
  C.feet = { ...feetAt(e), x: e.x + 1 }
  u = run2(q, u, 3)
  C.feet = FAR
  u = run2(q, u, 45)
  check(D.v.stats.rewinds > 0 && same(C.v, D.v), 'a startle heard forty seconds late, past every state kept, is replayed from the chapter\'s start')

  const other = new Villagers(new THREE.Scene(), water, { walk, roads: room.doc.roads, doors, lake: room.lake, seats, seed: spec.seed + 1, asset: makeAsset() })
  other.update(FAR, head(FAR), T0, 1 / 60)
  for (const a of log) other.apply(a)
  check(other.log.size === 0, 'another village lets the startles go')
  let threw = false
  try { B.v.apply([`${B.v.wire}zz:1`, t, 0, 0, 0, 0, 0, 'startle', 'b', 99]) } catch { threw = true }
  check(threw, 'a startle naming a villager this village has not is refused')
}

console.log(failures === 0 ? '\nall ok' : `\n${failures} failing`)
process.exit(failures === 0 ? 0 : 1)
