// ---------------------------------------------------------------------------
// THE VILLAGERS: the leafkin who live in the village (rooms/village.js), one a
// house and EXTRA more, a metre tall, going about the roads. DESIGN.md §30 has
// the whole of it; here is the state machine and how it is stepped.
//
// They walk a GRAPH of the build's roads (roadGraph): every road but the pads
// sampled SAMPLE_M apart, a road's end joined to the nearest node of another
// within JOIN_M, and every house door a node off its nearest road node. Every
// trip is a shortest path over it, so a villager is always on the cobbles,
// which the build keeps dry, clear of the huts and off the lamps -- no step is
// probed. The whole village steps tick by tick together on the score's ticks
// (sim/score.js) of the room's clock, every roll off a PRNG kept on the
// villager and seeded from the room, the villager and the village's chapter.
// A chapter's turn puts everyone indoors (HOMING_S before it they make for
// their doors), so a client arriving mid-chapter places them there at its
// start and replays it silent, landing where the room's are. Her feet are the
// one thing a client knows that the others do not: a startle is an EVENT sent
// to the room, and a client hearing one for a tick it has stepped past rolls
// back to a snapshot before it and replays (design/30-leafkin.md, Netplay).
//
//   inside   in its house, unseen, INSIDE_S; then out of the door on an --
//   errand   home (up its steps to the door's sill, inside), gaze (to one of GAZE_SPOTS on
//            the loop, GAZE_OFF_M off it toward the water, and stand facing
//            the lake GAZE_S), sit (to a free one of the room's `seats`, the
//            hearth's stools and the scattered ones, round its side to the
//            point its feet stand at) or wander (to a node of the loop, the
//            ring or a branch, and stand STAND_S), weighted by ERRANDS; then
//            another. Each goes at its own PACE, and a RUNNERS share run.
//   sit      at its stool: turns to its look (the fire, the lake), sits down
//            on the sit clip's first SIT_CUT[0] seconds, holds on idle-sit
//            SIT_S facing it, rises on the clip from SIT_CUT[1], and plans
//            again from its node. The stool is its from the errand's roll to
//            its rising; it stops for no talk, but a fright lets it go.
//   talk     two passing within TALK_M with neither TALK_COOL_S from its last
//            talk stop, face each other and chatter by turns TALK_S, a talk
//            gesture with every call.
//   (all)    nobody walks through anybody: a mover veers off its route to
//            pass on its right anyone LOOK_M ahead, never steps within
//            SPACE_M of another, counts a point taken by someone as reached
//            beside them, and STALL_S blocked gives the errand up.
//   flee     a player's feet within STARTLE_M: it runs home round them,
//            whimpering and panting by turns, and hides indoors HIDE_S. One
//   startle  carrying mushrooms first faces them, recoils and screams
//            STARTLE_S (leafkin.js), and lets them fall.
//   away     the forage trip, a chapter's with FORAGE_ODDS: one villager, out
//            of its door within LEAVE_S, walks out of the exit mouth and is
//   give     gone AWAY_S; back with a mushroom for each of up to CARRY_MAX
//            others, it seeks out whoever is nearest. Whoever sees it within
//            SEE_M squeals once and, called, comes for one while it waits,
//            talks GIFT_S and goes home to eat it (residents.js `feast`).
//   pick     a mushroom lying still within FIND_M of a free villager: it
//            squeals, runs to it, gathers it up and runs home to eat it.
//   frog     a frog chasing a hob (frogs.js chasers) within FROG_SEE_M of a
//            free villager: it screams FROG_CRY_S, runs to where it saw it,
//            gathers it up and walks it to the nearest water (_shore),
//            chattering, throws it THROW_M out, watches, and goes on. An
//            event like a find; `claims` hands the frog to frogs.js.
//   court    her with a mushroom in hand within LURE_M: it squeals and creeps
//            to her, beckoning; held out over it, the mushroom is its, and it
//            runs home chattering to eat it, and trusts her from then on.
//   greet    one that trusts her, free within GREET_M (FRIEND_M, gladder,
//            once all do): it comes, beckons and chatters GREET_S, goes on.
//            Her client alone knows her hands and her trust (trust.js), so
//            lures, offers and greetings are events like a startle.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { CHAPTER_S, SILENT_TICKS, TICK_HZ, TICK_S, chapterOf, hash32, swing, tickAfter, tickOf } from '../../sim/score.js'
import { snap } from '../creature-net.js'
import { CARRY_MAX, CARRIERS } from '../hands.js'
import { Spline } from '../layers/spline.js'
import { CRITTER_GLB, LOD_RUNGS, critterTier } from './critters.js'
import { CARRY_SPAN, STARTLE_S } from './leafkin.js'
import { lodFadeS, Puppet, cloneBones, groundFeet, makePuppetMaterials, makeSettledMaterial } from './puppet.js'
import { loadBipedGlb } from './snowmen.js'
import { LEAD_TICKS, ease, easeFields, keepWas, popM, warnPop } from './net-ease.js'
import { keyOf as frogKey } from './frogs.js'

export const LOD_TIERS = LOD_RUNGS
export const PUPPETS = 8
// Villagers past one a house; each lives in house k % houses.
export const EXTRA = 1
export const SIZE_M = 1
export const SIZE_VAR = 0.15
// Each villager's own pace, on the gait's ground speed and the clip's rate alike, and the share that run their errands rather than walk (never fewer than one a village).
export const PACE = [0.75, 1.3]
export const RUNNERS = 0.25
// The graph: metres between a road's nodes, how far a road's end reaches for another road, and how near a node counts as reached.
export const SAMPLE_M = 1.5
export const JOIN_M = 3
export const NODE_M = 0.35
// Gazing spots round the loop, each this far off it toward the water where that is dry and clear.
export const GAZE_SPOTS = 4
export const GAZE_OFF_M = 1
export const INSIDE_S = [20, 90]
export const STAND_S = [3, 10]
export const GAZE_S = [15, 40]
export const SIT_S = [20, 60]
export const ERRANDS = [['home', 0.2], ['gaze', 0.25], ['sit', 0.25], ['wander', 0.3]]
// The sit clip is one round trip, down by SIT_CUT[0] seconds and rising from SIT_CUT[1], the hold between them idle-sit's pose (tools/creatures/anim/clips/human/sit.json); at the hold the hips sit `back` of the wheelbase behind the feet, and the body is set down by what touches the stool (seatY). The feet stand `clear` metres past the stool's edge at the least, or the walker would lift the sitter onto it, reached within `near` metres (NODE_M's slack would leave the hips off the stool), and it comes round the stool `round` metres wide of its side.
export const SIT_CUT = [1.4, 3.0]
// Metres a SIZE_M leafkin's seated underside rides over the ground it sits down on: what a stool's top is cut to (hearth.js cutStool). The runtime measures each body's own (seatY) and setAsset refuses an asset whose sit has drifted from this, since the stools were cut before it loaded.
export const SEAT_M = 0.19
export const SIT = { back: 0.5, clear: 0.05, near: 0.03, round: 0.5 }
export const TALK_M = 1.6
export const TALK_S = [8, 20]
export const TALK_COOL_S = 45
export const CHATTER_S = [1.5, 3]
export const CHATTERS = 4
export const STARTLE_M = 3
export const HIDE_S = [120, 300]
export const WHIMPER_S = [2.7, 4.1]
// Road within this of her feet costs a fleer this many times its length, so it runs round her rather than past her.
const SHUN_M = 6
const SHUN = 10
export const TURN_RATE = 6
export const FLEE_TURN = 10
// A gait or a hold extended in place when it runs out; the chest, as a fraction of the body, the voice comes from.
const STEP_S = 2
const CHEST = 0.5
// The clip crossfade, and the dither out of sight through a door.
const FADE_S = 0.25
export const DOOR_FADE_S = 0.25
// Two bodies' centres keep SPACE_M apart (at SIZE_M; scaled by their mean size); everyone keeps KEEP_M right of a road's centreline; a mover looks LOOK_M ahead for someone within that of its line and veers up to DODGE off its route, more the nearer they are and the less room it has, but never past LANE_M of the leg it walks or the roads (PART_M to part from someone it stands inside); STALL_S of no headway and it gives up the errand, or plans the flight again. All of them are stepped tick by tick together (update), so each sees the others where they stand now.
export const SPACE_M = 0.4
export const LOOK_M = 2.5
export const DODGE = (60 * Math.PI) / 180
export const STALL_S = 3
export const LANE_M = 0.5
export const KEEP_M = 0.22
export const PART_M = 0.75
export const FORAGE_ODDS = 0.5
export const LEAVE_S = [5, 20]
export const AWAY_S = [270, 300]
export const MOUTH_M = 0.5
export const SEE_M = 30
export const GIFT_S = [4, 8]
export const GIVE_S = 30
// A mushroom found: lying still within FIND_M of the villager, FIND_ROAD_M of a road node and FIND_UP_M over the ground; picked up once the villager stands within PICK_M of it.
export const FIND_M = 8
const FIND_ROAD_M = 4
const FIND_UP_M = 0.5
const PICK_M = 1
// A frog seen chasing a hob: within FROG_SEE_M, water within FROG_SHORE_M of it to throw it in, THROW_M out past the bank; the scream is threaten's first FROG_CRY_S, the throw its first THROW_CUT with the frog let go at THROW_AT, then FROG_WATCH_S watching it land.
export const FROG_SEE_M = 10
export const FROG_SHORE_M = 8
export const THROW_M = 1.5
export const FROG_CRY_S = 1.2
const THROW_CUT = 1
const THROW_AT = 0.55
const FROG_WATCH_S = 1.5
const SHORE_BEARINGS = 24
// A mushroom in her hand within LURE_M: a squeal, and it creeps to her CREEP_S at a time, pausing PAUSE_S to beckon, to stop COURT_STOP_M short of her feet (off the road where she stands within COURT_ROAD_M of it). Her client keeps it coming every LURE_EVERY_S or when she moves REPLAN_M; COURT_S after the last it watches her WATCH_S and goes on its way, and her feet frighten it no more till CALM_S after her hand empties. A mushroom held within OFFER_M of its body or fist, under OFFER_UP of its size, is taken.
export const LURE_M = 8
export const LURE_EVERY_S = 3
export const COURT_S = 7
const CREEP_S = [1, 2.5]
const PAUSE_S = [1.2, 2.5]
export const COURT_STOP_M = 0.9
const COURT_ROAD_M = 5
export const REPLAN_M = 0.75
const WATCH_S = [3, 6]
export const CALM_S = 60
export const OFFER_M = 0.5
export const OFFER_UP = 1.6
// One that trusts her (trust.js), free and within GREET_M -- FRIEND_M once the whole village does, and gladder -- walks up, beckons and chatters GREET_S, and goes on; not again for GREET_COOL_S. Standing for her, a gesture every FUSS_S.
export const GREET_M = 5
export const FRIEND_M = 12
export const GREET_S = [6, 10]
export const GREET_COOL_S = 75
export const FUSS_S = [2, 4]
const NO_CHASES = []
const NO_LURES = []
const NOBODY = () => false
const PREFIX = { startle: '', find: 'f', frog: 'g', lure: 'l', offer: 'o', greet: 'w', hail: 'h' }
// Ticks between looks for someone to talk to, or to call for a mushroom.
const MEET_TICKS = 10
// Seconds before a chapter's turn that everyone makes for home, so the turn finds them indoors.
export const HOMING_S = 120
// The village's state is kept every SNAP_TICKS, SNAPS deep, for a startle heard late to roll back to; one older than that replays the chapter.
const SNAP_TICKS = 20
const SNAPS = 30
// A startle's anchor: its extra fields are the villagers it names (server/src/main.js ANCHOR_MAX_FIELDS).
const MAX_NAMED = 15
// A villager's state the rollback keeps; route, partner and seat are kept beside them.
const KEPT = ['rs', 'x', 'y', 'z', 'heading', 'px', 'py', 'pz', 'ph', 'aim', 'state', 'hidden', 'at', 'wp', 'then', 'hold', 'voice', 'panted', 'talked', 'phase', 'stall', 'side', 'clip', 'left', 'dur', 'cycle', 'speed', 'from', 'fx', 'fz', 'trip', 'bundle', 'saw', 'fed', 'feast', 'frog', 'toss', 'tossAt', 'lapse', 'calm', 'glad', 'greeted', 'warm']
// Salts the chapter's forage roll off the villagers' own.
const FORAGE_SALT = 0xf0a6e

/** mulberry32 with its state on the villager (`rs`), so a snapshot keeps where its rolls are. */
function roll(c) {
  c.rs = (c.rs + 0x6d2b79f5) >>> 0
  let t = c.rs
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export const TALKS = ['talk-gesture', 'talk-point', 'talk-nod', 'talk-shrug']
export const BECKONS = ['beckon', 'beckon', 'wave', 'talk-gesture', 'talk-point']
export const CLIPS = ['idle', 'walk', 'run', 'sit', 'idle-sit', 'recoil', 'gather', 'threaten', 'beckon', 'wave', ...TALKS]
// The standing gestures, each ending on the idle (_step).
const GESTURES = new Set(['beckon', 'wave', ...TALKS])
// The clips whose feet stay put (puppet.js FootIK). A sit is not among them: the solver drops the root onto the ground under the feet, which is the one thing that would pull a seated body off its stool.
export const PLANTED = new Set(['idle', ...GESTURES])

const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()
const sameFrog = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2]

const UP = new THREE.Vector3(0, 1, 0)
const _quat = new THREE.Quaternion()
const _pos = new THREE.Vector3()
const _scl = new THREE.Vector3()
const _grip = new THREE.Vector3()
const _bone = new THREE.Vector3()

// The right fist: its two fingers' knuckles and tips, whose mean sits in the closed hand.
const GRIP_BONES = ['bone_19', 'bone_21', 'bone_22', 'bone_24']
const grips = new WeakMap()

/** Where `puppet`'s right fist is, in its group's parent space, into `out`; false for a body with no such fingers. Stale by up to the puppet's pose cadence. */
export function gripAt(puppet, out) {
  let bones = grips.get(puppet)
  if (bones === undefined) {
    const found = GRIP_BONES.map((name) => puppet.bones.find((b) => b.name === name))
    bones = found.every(Boolean) ? found : null
    grips.set(puppet, bones)
  }
  if (bones === null) return false
  out.set(0, 0, 0)
  for (const b of bones) out.add(_bone.setFromMatrixPosition(b.matrixWorld))
  out.multiplyScalar(1 / bones.length).applyMatrix4(puppet.group.matrix)
  return true
}
const _mat = new THREE.Matrix4()

/**
 * How high a seated body's underside rides over the rig's own floor, in the
 * asset's units: the lowest skinned vertex of the pelvis and the thighs with
 * the hold pose on the rig, so a sitter can be set down by what touches the
 * stool rather than by its feet (`_move`, DESIGN.md §30). A vertex counts only
 * where those bones carry all of its weight; the leafkin's is 0.145 of its
 * height, a thigh's thickness below the hip joint.
 */
export function seatY(asset) {
  const copies = new Map()
  const rig = cloneBones(asset.root, copies)
  const mixer = new THREE.AnimationMixer(rig)
  mixer.clipAction(asset.clips.find((c) => c.name === 'idle-sit')).play()
  mixer.update(0)
  rig.updateMatrixWorld(true)
  const seated = new Set([asset.root.name, ...asset.legs.map((l) => THREE.PropertyBinding.sanitizeNodeName(l.chain[0]))])
  const skin = asset.skeleton.bones.map((b, i) => (seated.has(b.name) ? new THREE.Matrix4().multiplyMatrices(copies.get(b).matrixWorld, asset.skeleton.boneInverses[i]) : null))
  const geo = asset.tiers[0]
  const pos = geo.getAttribute('position'), index = geo.getAttribute('skinIndex'), weight = geo.getAttribute('skinWeight')
  const e = _mat.elements
  let low = Infinity
  for (let v = 0; v < pos.count; v++) {
    e.fill(0)
    let held = 0
    for (let k = 0; k < 4; k++) {
      const w = weight.getComponent(v, k)
      if (w <= 0) continue
      const m = skin[index.getComponent(v, k)]
      if (!m) { held = 0; break }
      for (let i = 0; i < 16; i++) e[i] += m.elements[i] * w
      held += w
    }
    if (held < 0.999) continue
    const y = _pos.fromBufferAttribute(pos, v).applyMatrix4(_mat).y
    if (y < low) low = y
  }
  if (!(low >= 0 && low < asset.height)) throw new Error(`Villagers: the seated underside measures ${low} against a body ${asset.height} tall`)
  return low
}

/**
 * The roads as a graph: `nodes` `[{ x, z, road }]`, `adj` each node's
 * neighbours, and `doorNodes`, the node of each door in `doors` order (road
 * 'door', with its `sill`). `roads` are the build's doc roads, `[x, y, z, w]` points.
 */
export function roadGraph(roads, doors) {
  const nodes = [], adj = []
  const add = (x, z, road) => { nodes.push({ x, z, road }); adj.push([]); return nodes.length - 1 }
  const link = (a, b) => { if (a === b || adj[a].includes(b)) return; adj[a].push(b); adj[b].push(a) }
  const nearest = (x, z, skip) => {
    let best = -1, at = Infinity
    for (let i = 0; i < nodes.length; i++) {
      if (skip(i)) continue
      const d = Math.hypot(nodes[i].x - x, nodes[i].z - z)
      if (d < at) { at = d; best = i }
    }
    return [best, at]
  }
  const ends = []
  for (const r of roads) {
    if (r.id.startsWith('pad-')) continue
    const s = new Spline(r.pts).flatten(SAMPLE_M)
    let prev = -1, first = -1
    for (let i = 0; i < s.length; i += 4) {
      const n = add(s[i], s[i + 2], r.id)
      if (prev >= 0) link(prev, n); else first = n
      prev = n
    }
    ends.push(first, prev)
  }
  if (nodes.length === 0) throw new Error('roadGraph: no roads')
  // A road's end onto whatever road it was drawn to meet: another, or its own far end where it closes on itself.
  for (const e of ends) {
    const n = nodes[e]
    const [j, d] = nearest(n.x, n.z, (i) => i === e || (nodes[i].road === n.road && Math.abs(i - e) < 3))
    if (j >= 0 && d <= JOIN_M) link(e, j)
  }
  const doorNodes = doors.map(({ x, z, sill }) => {
    if (!sill || !Number.isFinite(sill.x) || !Number.isFinite(sill.z)) throw new Error('roadGraph: a door without its sill')
    const [j] = nearest(x, z, () => false)
    const n = add(x, z, 'door')
    nodes[n].sill = sill
    link(n, j)
    return n
  })
  return { nodes, adj, doorNodes }
}

/**
 * Dijkstra over the graph from `from`: `dist` to every node and `parent`
 * along the way, stopped once `to` is settled (-1 for the whole graph). A
 * node's `weight`, if given, scales the length of every edge into it.
 */
export function dijkstra(g, from, to = -1, weight = null) {
  const n = g.nodes.length
  const dist = new Float64Array(n).fill(Infinity), parent = new Int32Array(n).fill(-1), done = new Uint8Array(n)
  const heapK = [], heapF = []
  const push = (k, f) => {
    let i = heapK.length
    heapK.push(k); heapF.push(f)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (heapF[p] <= heapF[i]) break
      ;[heapK[p], heapK[i]] = [heapK[i], heapK[p]]; [heapF[p], heapF[i]] = [heapF[i], heapF[p]]
      i = p
    }
  }
  const pop = () => {
    const k = heapK[0]
    const lk = heapK.pop(), lf = heapF.pop()
    if (heapK.length > 0) {
      heapK[0] = lk; heapF[0] = lf
      let i = 0
      for (;;) {
        const a = 2 * i + 1, b = a + 1
        let m = i
        if (a < heapK.length && heapF[a] < heapF[m]) m = a
        if (b < heapK.length && heapF[b] < heapF[m]) m = b
        if (m === i) break
        ;[heapK[m], heapK[i]] = [heapK[i], heapK[m]]; [heapF[m], heapF[i]] = [heapF[i], heapF[m]]
        i = m
      }
    }
    return k
  }
  dist[from] = 0
  push(from, 0)
  while (heapK.length > 0) {
    const k = pop()
    if (done[k]) continue
    done[k] = 1
    if (k === to) break
    const a = g.nodes[k]
    for (const j of g.adj[k]) {
      if (done[j]) continue
      const b = g.nodes[j]
      const d = dist[k] + Math.hypot(b.x - a.x, b.z - a.z) * (weight ? weight(j) : 1)
      if (d >= dist[j]) continue
      dist[j] = d
      parent[j] = k
      push(j, d)
    }
  }
  return { dist, parent }
}

/** The nodes from `from` to `to` after `from`, by `parent`; empty when `to` is unreached or is `from`. */
export function pathTo(parent, from, to) {
  if (to === from || parent[to] < 0) return []
  const path = []
  for (let k = to; k !== from; k = parent[k]) path.push(k)
  return path.reverse()
}

export class Villagers {
  /**
   * @param water        WaterSurfaces: isSubmerged, for the gazing spots
   * @param opts.walk    WalkSurface: heightAt
   * @param opts.roads   the build's doc roads
   * @param opts.doors   RoomProps.doors(): `[{ x, z, sill }]`
   * @param opts.lake    the build's lake: x, z
   * @param opts.seats   the stools, `[{ x, z, top, r, lookX, lookZ }]`: each a disc of `r` about (x, z) whose top is `top` in the world, sat on facing (lookX, lookZ)
   * @param opts.seed    the room's seed, a uint32 every client of the room shares
   * @param opts.asset   a loaded asset, for a gate; the world fetches the GLB
   * @param opts.exit    the exit mouth, `{ x, z, nx, nz }` (village.js), for the forage trip; without it there is none
   * @param opts.hands   Hands and the room's Mushrooms together, for the bundle drawn in its arms; without them it is not drawn
   */
  constructor(scene, water, { walk, roads, doors, lake, seats = [], seed = 1, asset = null, exit = null, hands = null, mushrooms = null } = {}) {
    if (!water || typeof water.isSubmerged !== 'function') throw new Error('Villagers need WaterSurfaces, for isSubmerged')
    if (!walk || typeof walk.heightAt !== 'function') throw new Error('Villagers need the WalkSurface, for heightAt')
    if (!Number.isInteger(seed) || seed < 0) throw new Error(`Villagers: the seed is a uint32, got ${seed}`)
    if (!Array.isArray(roads) || !Array.isArray(doors) || doors.length === 0) throw new Error('Villagers need the roads and at least one door')
    if (!lake || !Number.isFinite(lake.x) || !Number.isFinite(lake.z)) throw new Error('Villagers need the lake, for where to gaze')
    if (!Array.isArray(seats)) throw new Error('Villagers: seats is a list')
    if (exit !== null && ![exit.x, exit.z, exit.nx, exit.nz].every(Number.isFinite)) throw new Error('Villagers: the exit is { x, z, nx, nz }')
    if ((hands === null) !== (mushrooms === null)) throw new Error('Villagers: the bundle needs both the hands and the mushrooms')
    this.hands = hands
    this.mushrooms = mushrooms
    this.water = water
    this.walk = walk
    this.seed = seed
    this.key = `village:${seed}`
    // Every startle's and find's anchor wears this: the village it is for.
    this.wire = `vg:${seed.toString(36)}:`
    this.graph = roadGraph(roads, doors)
    const { nodes, doorNodes } = this.graph
    // Where a wander may end: any node of a road but the trunk, which leads only to her door.
    this.targets = nodes.map((n, i) => i).filter((i) => nodes[i].road !== 'd1' && nodes[i].road !== 'door')
    if (this.targets.length === 0) throw new Error('Villagers: no road to wander')
    // The seats, each reached from the node nearest it, and who has claimed it.
    this.seats = seats.map((s) => {
      if (![s.x, s.z, s.top, s.r, s.lookX, s.lookZ].every(Number.isFinite) || !(s.r > 0)) throw new Error(`Villagers: a seat is { x, z, top, r, lookX, lookZ }: ${JSON.stringify(s)}`)
      let node = -1, at = Infinity
      for (let i = 0; i < nodes.length; i++) {
        const d = Math.hypot(nodes[i].x - s.x, nodes[i].z - s.z)
        if (d < at) { at = d; node = i }
      }
      return { x: s.x, z: s.z, top: s.top, r: s.r, lookX: s.lookX, lookZ: s.lookZ, node, by: null }
    })
    // The gazing spots: GAZE_SPOTS nodes spread along the loop, each with a stand a step toward the water where it can stand there, and no stool stands.
    const loop = nodes.map((n, i) => i).filter((i) => nodes[i].road === 'd2')
    if (loop.length === 0) throw new Error('Villagers: no loop to gaze from')
    this.spots = Array.from({ length: GAZE_SPOTS }, (_, k) => {
      const node = loop[Math.floor(((k + 0.5) / GAZE_SPOTS) * loop.length)]
      const n = nodes[node]
      const a = Math.atan2(lake.z - n.z, lake.x - n.x)
      const x = n.x + Math.cos(a) * GAZE_OFF_M, z = n.z + Math.sin(a) * GAZE_OFF_M
      const stool = this.seats.some((s) => Math.hypot(s.x - x, s.z - z) < s.r + SIT.round)
      return stool || this.seat(x, z) === null ? { node, x: n.x, z: n.z } : { node, x, z }
    })
    this.lake = { x: lake.x, z: lake.z }
    // The forage trip's mouth, just in from the exit's face, reached from the trunk's node nearest it; this chapter's forager (-1 for none).
    this.mouth = null
    if (exit !== null) {
      this.mouth = { x: exit.x + exit.nx * MOUTH_M, z: exit.z + exit.nz * MOUTH_M, node: -1 }
      let at = Infinity
      for (let i = 0; i < nodes.length; i++) {
        const d = Math.hypot(nodes[i].x - this.mouth.x, nodes[i].z - this.mouth.z)
        if (nodes[i].road === 'd1' && d < at) { at = d; this.mouth.node = i }
      }
      if (this.mouth.node < 0) throw new Error('Villagers: no trunk to the exit')
    }
    this.forager = -1

    this.batch = new THREE.Group()
    this.batch.name = 'v2-villagers'
    scene.add(this.batch)
    this.plain = makeSettledMaterial('villagers')
    this.materials = [this.plain]
    this.puppetMats = []
    for (let i = 0; i < PUPPETS; i++) {
      const mats = makePuppetMaterials('villagers', this.plain)
      this.puppetMats.push(mats)
      this.materials.push(mats.in, mats.out)
    }
    this.all = []
    for (let k = 0; k < doors.length + EXTRA; k++) {
      const c = {
        id: k, key: `villager:${k}`, home: doorNodes[k % doors.length], rs: 0, rand: null, size: 1, k: 1, pace: 1, runner: false,
        // The tick's pose and the one before it, for the frame to lerp.
        x: 0, y: 0, z: 0, heading: 0, px: 0, py: 0, pz: 0, ph: 0, aim: 0,
        // The frame's pose, what the puppet and the ear are given.
        pose: { x: 0, y: 0, z: 0, heading: 0, k: 1, speed: 0, clip: 'idle', cycle: 0, size: 1 },
        // inside, walk, stand, gaze, sit, talk, startle, flee, away, give, pick, frog, court or greet; inside or away, it is drawn by nobody.
        state: 'inside', hidden: true,
        // The node it stands at or is making for, the route on from it (`{ x, z, node }`, node -1 off the road), the point of it it is on, and what the route's end is for: stand, gaze, sit, enter, hide, errand, leave, take, pick.
        at: 0, route: [], wp: 0, then: 'stand',
        // Seconds the state has left, to the next call, whether the last was a pant, and until it will talk again; who it is talking to; the seat it has claimed and where a sit is: turn, down, hold, up; seconds blocked.
        hold: 0, voice: 0, panted: false, talked: 0, partner: null, seat: null, phase: '', stall: 0, side: 0,
        // The clip playing, how long it holds, that step's whole length, the clip's own length, a count of steps, the ground speed, and the second of the clip the step cuts in at (-1 to fade in from its start).
        clip: 'idle', left: 0, dur: 0, cycle: 0, cue: 0, speed: 0, from: -1,
        // Where the player it last ran from stood.
        fx: 0, fz: 0,
        // The forage trip: '', 'out' (the forager, not yet gone) or 'back' (with `bundle` mushrooms to give); whether it has squealed at this trip's bundle, been given one, and has it yet to eat; its carrier. A giver's `partner` is whoever it talks to, a taker's the giver it is called to.
        trip: '', bundle: 0, saw: false, fed: false, feast: false, carrier: null,
        // The frog it is seeing to, `[tx, tz, index]` (frogs.js keyOf), the bank it walks it to and the water it throws it at, `{ ex, ez, wx, wz }`, and the second it let go; and its hold as frogs.js reads it.
        frog: null, toss: null, tossAt: null, claim: { phase: 'wait', x: 0, y: 0, z: 0, heading: 0, t0: 0, from: { x: 0, y: 0, z: 0 }, to: { x: 0, z: 0 } },
        // Her, standing for whom it courts or greets at (fx, fz): seconds till a court lapses, till she can frighten it again, whether it chatters home with her mushroom, till it greets her again, and whether the greeting is a friend's.
        lapse: 0, calm: 0, glad: false, greeted: 0, warm: false,
        lod: LOD_TIERS, puppet: null,
        ...easeFields(),
      }
      c.rand = () => roll(c)
      this.all.push(c)
    }
    this.puppets = []
    this.freePuppets = []
    this.asset = null
    this.durations = null
    // One-shots for the ear, drained by voices(): { sound, x, y, z }.
    this.calls = []
    this.feet = { x: 0, y: 0, z: 0 }
    this.head = { x: 0, y: 0, z: 0 }
    this.frame = 0
    this.loaded = false
    // The village's last tick stepped (null until placed), the tick its chapter turns on, how far into the next tick the frame is, and the highest tick ever stepped: a tick past it is live, heard and watched for her feet, one at or under it a replay.
    this.tick = null
    this.turnTick = 0
    this.alpha = 0
    this.live = -Infinity
    this.voicing = false
    this.homing = false
    // The startles, the room's and hers: tick -> [{ key, tick, fx, fy, fz, ids, by, done }] sorted by key; hers owed to the relay; the kept states; and the earliest tick a startle heard late needs stepped again.
    this.log = new Map()
    this.outbox = []
    this.snaps = []
    this.rewind = Infinity
    this.rewinds = 0
    this.popped = 0
    // This frame rolled back (and how many ticks), the deepest rollback yet, pops drawn and when one was last said (net-ease.js); and each villager her startle has already whimpered for, until the tick its own first whimper would come.
    this.rolled = false
    this.rewound = 0
    this.maxRewind = 0
    this.jumps = 0
    this.jumpSaidAt = -Infinity
    this.hushed = new Map()
    // The loose mushrooms this client has raised a find for.
    this.sought = new WeakSet()
    // Her mushrooms in hand this frame (hands.js lures, hers alone), whether villager `id` trusts her, and whom she has fed since befriended() last drained them.
    this.held = []
    this.trusts = NOBODY
    this.won = []
    this.hearsOwn = true
    // The frogs chasing hobs this frame (frogs.js chasers), and the villagers' holds on frogs by frog key, for frogs.js.
    this.chases = NO_CHASES
    this.claims = new Map()
    this.starved = 0
    this.talks = 0
    this.gifts = 0
    this.startles = 0
    this.offers = 0
    this.greets = 0

    if (asset) {
      this.setAsset(asset)
      this.ready = Promise.resolve(true)
    } else {
      this.ready = this.load()
    }
  }

  async load() {
    this.setAsset(await loadBipedGlb(CRITTER_GLB.leafkin))
    return true
  }

  setAsset(asset) {
    for (const name of CLIPS) if (!asset.clips.some((c) => c.name === name)) throw new Error(`Villagers: the asset has no ${name} clip`)
    this.asset = asset
    this.sitY = seatY(asset)
    if (Math.abs((this.sitY / asset.height) * SIZE_M - SEAT_M) > 0.03) throw new Error(`Villagers: a ${SIZE_M} m body of this one sits ${((this.sitY / asset.height) * SIZE_M).toFixed(3)} m up, and the stools are cut to ${SEAT_M}`)
    this.durations = Object.fromEntries(asset.clips.map((c) => [c.name, c.duration]))
    if (!(this.durations.sit > SIT_CUT[1] && SIT_CUT[0] < SIT_CUT[1])) throw new Error(`Villagers: the sit clip is ${this.durations.sit} s, cut at ${SIT_CUT}`)
    this.plain.map = asset.map
    this.plain.needsUpdate = true
    for (const mats of this.puppetMats) {
      for (const m of [mats.in, mats.out]) {
        m.map = asset.map
        m.needsUpdate = true
      }
      this.puppets.push(new Puppet(asset, mats, { clipFade: FADE_S }))
    }
    this.freePuppets = this.puppets.slice()
    let fastest = null
    for (const c of this.all) {
      const rand = mulberry32(hash32(this.seed, c.id))
      c.size = SIZE_M * (1 + SIZE_VAR * (2 * rand() - 1))
      c.k = c.size / asset.height
      c.pace = between(rand, PACE)
      c.runner = rand() < RUNNERS
      if (fastest === null || c.pace > fastest.pace) fastest = c
    }
    if (!this.all.some((c) => c.runner)) fastest.runner = true
    this.loaded = true
  }

  /** The ground at (x, z) it may stand on, or null: dry. Not the trunks: which trees a client holds is its own residency, and every client must refuse the same steps. */
  seat(x, z) {
    const y = this.walk.heightAt(x, z)
    if (this.water.isSubmerged(x, z, y)) return null
    return y
  }

  get stats() {
    const states = { inside: 0, walk: 0, stand: 0, gaze: 0, sit: 0, talk: 0, startle: 0, flee: 0, away: 0, give: 0, pick: 0, frog: 0, court: 0, greet: 0 }
    for (const c of this.all) states[c.state]++
    return { count: this.all.length, states, forager: this.forager, gifts: this.gifts, offers: this.offers, greets: this.greets, puppets: this.puppets.length - this.freePuppets.length, starved: this.starved, talks: this.talks, startles: this.startles, rewinds: this.rewinds, maxRewind: this.maxRewind, jumps: this.jumps, popped: this.popped, nodes: this.graph.nodes.length, seats: this.seats.length, taken: this.seats.filter((s) => s.by !== null).length }
  }

  /** Every villager drawn this frame, for the ear: its frame pose, with x, y, z, size, clip, cycle and speed. */
  bodies(into) {
    if (!this.batch.visible) return into
    for (const c of this.all) if (!c.hidden && c.lod < LOD_TIERS) into.push(c.pose)
    return into
  }

  /** The one-shots since the last call, each `{ sound, x, y, z }`, drained. */
  voices(into) {
    for (const v of this.calls) into.push(v)
    this.calls.length = 0
    return into
  }

  // -------------------------------------------------------------------------
  // What it is doing.
  // -------------------------------------------------------------------------

  _toward(c, x, z) { return Math.atan2(-(z - c.z), x - c.x) }

  /** A one-shot from its chest, heard by the layer's rule or by `rule` (ambience.js RULES). */
  _voice(c, sound, rule) {
    if (!this.voicing) return
    const until = this.hushed.get(c.id)
    if (until !== undefined && (sound === 'leafkinWhimper' || sound === 'leafkinScream')) {
      this.hushed.delete(c.id)
      if (this.tick <= until) return
    }
    this.calls.push({ sound, rule, x: c.x, y: c.y + c.size * CHEST, z: c.z })
  }

  /** The state's call, or a pant if the last was the call, and the wait to the next. */
  _call(c, sound, gap) {
    c.voice = between(c.rand, gap)
    c.panted = !c.panted
    this._voice(c, c.panted ? 'panting' : sound)
  }

  _chatter(c) {
    return `leafkinChatter${1 + Math.min(CHATTERS - 1, (c.rand() * CHATTERS) | 0)}`
  }

  /** The step's clip: faded in from its start, or cut in at `from` seconds of it. */
  _play(c, clip, seconds, from = -1) {
    c.clip = clip
    c.dur = seconds
    c.left = seconds
    c.cycle = this.durations[clip] / c.pace
    c.cue++
    c.from = from
    const speed = this.asset.gait[clip]
    c.speed = speed === undefined ? 0 : speed * c.k * c.pace
  }

  /** The step's clip has run out: extended in place, a talk gesture ending on the idle, a sit's cut ending its phase. */
  _step(c) {
    if (GESTURES.has(c.clip)) { this._play(c, 'idle', STEP_S); return }
    if (c.state === 'sit' && c.phase === 'down') { this._phase(c, 'hold'); return }
    if (c.state === 'sit' && c.phase === 'up') { this._rise(c); return }
    c.left = c.dur = STEP_S
  }

  /** Everyone into their houses at the start of the chapter `seconds` falls in, each a roll of INSIDE_S from coming out; the village's tick is the chapter's first, which is never stepped. The startles before it are let go. */
  _placeAll(seconds) {
    const { index, start } = chapterOf(seconds, this.key)
    this.tick = tickOf(start)
    this.turnTick = tickAfter(start + CHAPTER_S)
    const trip = mulberry32(hash32(this.seed, index, FORAGE_SALT))
    this.forager = this.mouth !== null && trip() < FORAGE_ODDS ? (trip() * this.all.length) | 0 : -1
    for (const c of this.all) {
      c.rs = hash32(this.seed, c.id, index)
      const home = this.graph.nodes[c.home]
      c.x = c.px = home.sill.x
      c.z = c.pz = home.sill.z
      // The road at the door read from under any stone (the door stands under the house's awning), and the sill a reach up from it.
      c.y = c.py = this.walk.heightAt(c.x, c.z, this.walk.heightAt(home.x, home.z, -Infinity))
      c.heading = c.ph = c.aim = 0
      c.at = c.home
      c.partner = null
      c.talked = 0
      c.fx = c.fz = 0
      c.voice = 0
      c.panted = false
      c.stall = c.side = 0
      c.phase = ''
      c.then = 'stand'
      c.trip = c.id === this.forager ? 'out' : ''
      c.bundle = 0
      c.saw = c.fed = c.feast = c.glad = c.warm = false
      c.lapse = c.calm = c.greeted = 0
      c.frog = c.toss = c.tossAt = null
      if (c.seat !== null) this._leaveSeat(c)
      this._inside(c, c.trip === 'out' ? between(c.rand, LEAVE_S) : c.rand() * INSIDE_S[1])
    }
    for (const t of this.log.keys()) if (t <= this.tick) this.log.delete(t)
    this.snaps.length = 0
    this._snap()
  }

  _leaveSeat(c) {
    if (c.seat === null) return
    if (c.seat.by !== c) throw new Error(`Villagers: ${c.key} leaves a seat it does not hold`)
    c.seat.by = null
    c.seat = null
  }

  _inside(c, wait) {
    c.state = 'inside'
    c.hidden = true
    c.hold = wait
    c.route.length = 0
    c.wp = 0
    this._play(c, 'idle', STEP_S)
  }

  /** Out of the door and off on an errand, once nobody stands in it. */
  _exit(c) {
    c.hidden = false
    c.feast = c.glad = false
    this._voice(c, 'door', 'door')
    this._errand(c)
  }

  /** A route to `node`, and beyond it `extra` off-road points (up its steps to the sill, for `enter`), ending in `then`; a seat claimed for anything else is let go, as is a giver it was called to. */
  _go(c, node, then, extra = []) {
    this._leaveSeat(c)
    if (then !== 'take') c.partner = null
    const { parent } = dijkstra(this.graph, c.at, node)
    c.route = this._keepRight(c, pathTo(parent, c.at, node))
    // Sent home from its own door, the sill's leg still starts at the door: a route of the sill alone has no leg to keep its lane on, and pins it half a metre up the steps.
    if (then === 'enter') extra = c.route.length === 0 ? [this.graph.nodes[node], this.graph.nodes[node].sill] : [this.graph.nodes[node].sill]
    for (const p of extra) c.route.push({ x: p.x, z: p.z, node: -1 })
    c.wp = 0
    c.then = then
    c.state = 'walk'
    // Out to forage, on its rounds with the bundle, over for a mushroom and home with one, anyone runs.
    this._play(c, c.runner || this.homing || c.trip !== '' || c.feast || then === 'take' || then === 'pick' || then === 'grab' ? 'run' : 'walk', STEP_S)
    if (c.route.length === 0) this._arrive(c)
  }

  _errand(c) {
    c.frog = c.toss = c.tossAt = null
    if (this.homing) { this._go(c, c.home, 'enter'); return }
    if (c.trip === 'out') { this._go(c, this.mouth.node, 'leave', [this.mouth]); return }
    if (c.trip === 'back') {
      // Its rounds: toward the nearest out of doors not yet given one, else the road before a door, never the node it stands on.
      let node = -1, at = Infinity
      for (const o of this.all) {
        const d = Math.hypot(o.x - c.x, o.z - c.z)
        if (o !== c && !o.hidden && !o.fed && o.at !== c.at && d < at) { at = d; node = o.at }
      }
      if (node < 0) {
        const { doorNodes, adj } = this.graph
        let k = (c.rand() * doorNodes.length) | 0
        if (adj[doorNodes[k]][0] === c.at) k = (k + 1) % doorNodes.length
        node = adj[doorNodes[k]][0]
      }
      this._go(c, node, 'stand')
      return
    }
    let roll = c.rand() * ERRANDS.reduce((s, [, w]) => s + w, 0)
    let kind = ERRANDS[ERRANDS.length - 1][0]
    for (const [k, w] of ERRANDS) { roll -= w; if (roll < 0) { kind = k; break } }
    if (kind === 'home' && c.at !== c.home) { this._go(c, c.home, 'enter'); return }
    if (kind === 'gaze') {
      const s = this.spots[(c.rand() * this.spots.length) | 0]
      this._go(c, s.node, 'gaze', s.x === this.graph.nodes[s.node].x && s.z === this.graph.nodes[s.node].z ? [] : [s])
      return
    }
    if (kind === 'sit') {
      const free = this.seats.filter((s) => s.by === null)
      if (free.length > 0) { this._seat(c, free[(c.rand() * free.length) | 0]); return }
    }
    let node = this.targets[(c.rand() * this.targets.length) | 0]
    if (node === c.at) node = this.targets[(this.targets.indexOf(node) + 1) % this.targets.length]
    this._go(c, node, 'stand')
  }

  _stand(c, hold) {
    c.state = 'stand'
    c.hold = hold
    this._play(c, 'idle', STEP_S)
  }

  _gaze(c) {
    c.state = 'gaze'
    c.hold = between(c.rand, GAZE_S)
    c.aim = this._toward(c, this.lake.x, this.lake.z)
    this._play(c, 'idle', STEP_S)
  }

  /** Its way onto `seat` from the seat's node: `feet`, where they stand, `SIT.back` of the wheelbase short of the stool's centre toward its look, and `round`, level with them SIT.round wide of the stool on the side its node is on. */
  _approach(c, seat) {
    const ax = seat.lookX - seat.x, az = seat.lookZ - seat.z, len = Math.hypot(ax, az)
    if (!(len > seat.r)) throw new Error(`Villagers: a seat looks at its own stool`)
    const ux = ax / len, uz = az / len
    const fore = Math.max(SIT.back * this.asset.wheelbase * c.k, seat.r + SIT.clear)
    const n = this.graph.nodes[seat.node]
    const wide = (Math.sign(-uz * (n.x - seat.x) + ux * (n.z - seat.z)) || 1) * (seat.r + SIT.round)
    const feet = { x: seat.x + ux * fore, z: seat.z + uz * fore }
    return { feet, round: { x: feet.x - uz * wide, z: feet.z + ux * wide } }
  }

  /** Off to `seat`, its from now. */
  _seat(c, seat) {
    const { feet, round } = this._approach(c, seat)
    this._go(c, seat.node, 'sit', [round, feet])
    c.seat = seat
    seat.by = c
  }

  /** Up from its stool: back round it to its node, and an errand from there. */
  _rise(c) {
    const { round } = this._approach(c, c.seat)
    const n = this.graph.nodes[c.at]
    this._go(c, c.at, 'errand', [round, { x: n.x, z: n.z }])
  }

  /** A sit's phases in turn: turn to the look, down on the sit clip's first cut, the seated hold, and up on its last; the cuts end with their step (_step). */
  _phase(c, phase) {
    c.phase = phase
    switch (phase) {
      case 'turn': c.aim = this._toward(c, c.seat.lookX, c.seat.lookZ); this._play(c, 'idle', STEP_S); break
      case 'down': this._play(c, 'sit', SIT_CUT[0] / c.pace); break
      case 'hold': c.hold = between(c.rand, SIT_S); this._play(c, 'idle-sit', STEP_S); break
      case 'up': this._play(c, 'sit', (this.durations.sit - SIT_CUT[1]) / c.pace, SIT_CUT[1]); break
      default: throw new Error(`Villagers: no sit phase named ${phase}`)
    }
  }

  /** The route's end. A gazer or a sitter walks back to its node before its next errand. */
  _arrive(c) {
    switch (c.then) {
      case 'stand': this._stand(c, between(c.rand, STAND_S)); break
      case 'gaze': this._gaze(c); break
      case 'sit': c.state = 'sit'; this._phase(c, 'turn'); break
      case 'enter':
      case 'hide': {
        // Reached beside someone on the steps, it is through the door all the same, and comes out of it.
        const { sill } = this.graph.nodes[c.home]
        c.x = sill.x
        c.z = sill.z
        this._voice(c, 'door', 'door')
        this._inside(c, between(c.rand, c.then === 'hide' ? HIDE_S : INSIDE_S))
        break
      }
      case 'errand': this._errand(c); break
      case 'leave': this._away(c); break
      case 'take': if (c.partner === null) this._errand(c); else this._stand(c, GIVE_S); break
      case 'pick': c.state = 'pick'; c.hold = this.durations.gather / c.pace; this._play(c, 'gather', c.hold); break
      case 'court':
      case 'greet':
        c.state = c.then
        c.phase = 'wait'
        if (c.state === 'greet') c.hold = between(c.rand, GREET_S)
        c.aim = this._toward(c, c.fx, c.fz)
        c.voice = Math.min(c.voice, 0.3)
        this._play(c, 'idle', STEP_S)
        break
      case 'grab':
        c.state = 'frog'
        c.phase = 'grab'
        c.aim = this._toward(c, c.fx, c.fz)
        c.hold = this.durations.gather / c.pace
        this._play(c, 'gather', c.hold)
        break
      case 'throw':
        c.state = 'frog'
        c.phase = 'throw'
        c.aim = this._toward(c, c.toss.wx, c.toss.wz)
        c.hold = THROW_CUT / c.pace
        this._play(c, 'threaten', c.hold)
        break
      default: throw new Error(`Villagers: a route ends in ${c.then}`)
    }
  }

  _talk(a, b, hold = between(a.rand, TALK_S)) {
    for (const [c, other, first] of [[a, b, true], [b, a, false]]) {
      c.state = 'talk'
      c.partner = other
      c.hold = hold
      c.voice = first ? 0.2 : between(c.rand, CHATTER_S) / 2
      c.aim = this._toward(c, other.x, other.z)
      c.route.length = 0
      c.wp = 0
      this._play(c, 'idle', STEP_S)
    }
    if (this.voicing) this.talks++
  }

  /** Out of a talk: the partner left standing takes up an errand of its own. */
  _untalk(c) {
    const p = c.partner
    c.partner = null
    c.talked = TALK_COOL_S
    if (p && p.partner === c) {
      p.partner = null
      p.talked = TALK_COOL_S
      this._done(p)
    }
  }

  /** Out of a talk: home to eat a mushroom just given it, back to waiting on whoever else it has called with its bundle, else a stand. */
  _done(c) {
    if (c.feast) this._go(c, c.home, 'enter')
    else if (c.trip === 'back') this._give(c)
    else this._stand(c, between(c.rand, STAND_S))
  }

  /** Out of the mouth and gone, unheard, AWAY_S. */
  _away(c) {
    c.state = 'away'
    c.hidden = true
    c.hold = between(c.rand, AWAY_S)
    this._play(c, 'idle', STEP_S)
  }

  /** In at the mouth with a mushroom for each of up to CARRY_MAX others, each of whom may see it afresh, and off on its rounds down the trunk. */
  _back(c) {
    c.x = this.mouth.x
    c.z = this.mouth.z
    c.y = this.walk.heightAt(c.x, c.z, c.y)
    c.at = this.mouth.node
    c.hidden = false
    c.trip = 'back'
    c.bundle = Math.min(CARRY_MAX, this.all.length - 1)
    for (const o of this.all) o.saw = o.fed = false
    this._voice(c, 'leafkinSqueal')
    this._errand(c)
    const n = this.graph.nodes[this.mouth.node]
    c.route.unshift({ x: n.x, z: n.z, node: this.mouth.node })
  }

  /** Standing for whoever it has called to come for a mushroom. */
  _give(c) {
    c.state = 'give'
    c.hold = GIVE_S
    c.route.length = 0
    c.wp = 0
    this._play(c, 'idle', STEP_S)
  }

  /** Who is on its way to `g` for a mushroom, nearest first; null for nobody. */
  _taker(g) {
    let best = null, at = Infinity
    for (const o of this.all) {
      if (o.partner !== g || o.then !== 'take' || (o.state !== 'walk' && o.state !== 'stand')) continue
      const d = Math.hypot(o.x - g.x, o.z - g.z)
      if (d < at) { at = d; best = o }
    }
    return best
  }

  /** The gatherer's look round: everyone in sight within SEE_M squeals the first time it sees the bundle, and whoever is free to comes for one, as many as it has; any called, it stops and waits for them. */
  _look(g) {
    let called = 0
    for (const o of this.all) if (o.partner === g && o.then === 'take') called++
    for (const o of this.all) {
      if (o === g || o.hidden || o.fed || o.state === 'flee' || o.state === 'startle' || Math.hypot(o.x - g.x, o.z - g.z) > SEE_M) continue
      if (!o.saw) { o.saw = true; this._voice(o, 'leafkinSqueal') }
      if (called >= g.bundle || o.partner !== null || o.frog !== null || (o.state !== 'walk' && o.state !== 'stand' && o.state !== 'gaze')) continue
      this._go(o, g.at, 'take', [g])
      // From its own node, where it stands off it: a stall re-plans an errand elsewhere, but a taker called again would take the same way into the same edge of its lane.
      const n = this.graph.nodes[o.at]
      if (Math.hypot(n.x - o.x, n.z - o.z) > NODE_M) o.route.unshift({ x: n.x, z: n.z, node: o.at })
      o.partner = g
      called++
    }
    if (called > 0 && g.state !== 'give') this._give(g)
  }

  /** A mushroom from `g`'s bundle into `t`'s arms, and a word between them. */
  _gift(g, t) {
    g.bundle--
    if (g.bundle === 0) g.trip = ''
    t.fed = t.feast = true
    this._voice(t, 'leafkinSqueal')
    this._talk(g, t, between(g.rand, GIFT_S))
    if (this.voicing) this.gifts++
  }

  /** The event of `kind` (PREFIX's) naming `c` on the tick being stepped, or null. */
  _eventOf(c, kind) {
    const events = this.log.get(this.tick)
    if (events) for (const e of events) if (e.kind === kind && e.ids.includes(c.id)) return e
    return null
  }

  /** This client's event of `kind` naming `ids` on `tick`, at (x, y, z) -- her feet for a startle, lure or greeting, the mushroom for a find or an offer, the frog for a frog, whose `[tx, tz, index]` is `frog`: logged, and owed to the room. */
  _raise(kind, x, y, z, ids, tick, frog = null) {
    const fx = snap(x), fy = snap(y), fz = snap(z)
    const key = `${this.wire}${tick.toString(36)}:${PREFIX[kind]}${hash32(Math.round(fx * 1000), Math.round(fz * 1000), ...ids, ...(frog ?? [])).toString(36)}`
    const e = this._log({ key, kind, tick, fx, fy, fz, ids, frog, by: null, done: false })
    this.outbox.push([key, tick / TICK_HZ, fx, fy, fz, 0, 0, kind, null, ...ids, ...(frog ?? [])])
    return e
  }

  /** Into the log in key order, so every client steps a tick's events alike; the one already there if the key is. */
  _log(e) {
    let events = this.log.get(e.tick)
    if (!events) this.log.set(e.tick, (events = []))
    const had = events.find((o) => o.key === e.key)
    if (had) return had
    events.push(e)
    events.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    return e
  }

  /** Its arms hold a mushroom or more: the bundle, or one to eat. */
  _carrying(c) { return c.bundle > 0 || c.feast }

  /** A fright: whoever it talks to or has called let go, and off home -- a carrier first recoiling where it stands, its mushrooms let fall (_carry). */
  _startle(c, e) {
    const carrying = this._carrying(c)
    if (!e.done) {
      this.startles++
      // A startle first stepped in a rollback is heard all the same, if it is fresh.
      if (!this.voicing && e.tick > this.live - SILENT_TICKS) this.calls.push({ sound: carrying ? 'leafkinScream' : 'leafkinWhimper', x: c.x, y: c.y + c.size * CHEST, z: c.z })
    }
    if (c.state === 'talk') this._untalk(c)
    for (const o of this.all) if (o.partner === c) o.partner = null
    this._leaveSeat(c)
    c.partner = null
    c.frog = c.toss = c.tossAt = null
    c.fx = e.fx
    c.fz = e.fz
    c.voice = 0.1
    c.panted = true
    if (!carrying) { this._flee(c); return }
    c.bundle = 0
    c.trip = ''
    c.feast = c.glad = false
    c.state = 'startle'
    c.hold = STARTLE_S
    c.aim = this._toward(c, e.fx, e.fz)
    c.route.length = 0
    c.wp = 0
    this._voice(c, 'leafkinScream')
    this._play(c, 'recoil', STARTLE_S)
  }

  /** Home, round where the player stood, to hide HIDE_S. */
  _flee(c) {
    const { nodes } = this.graph
    const home = nodes[c.home]
    const shun = (j) => (Math.hypot(nodes[j].x - c.fx, nodes[j].z - c.fz) < SHUN_M ? SHUN : 1)
    const { parent } = dijkstra(this.graph, c.at, c.home, shun)
    c.route = this._keepRight(c, pathTo(parent, c.at, c.home))
    if (c.route.length === 0) c.route.push({ x: home.x, z: home.z, node: c.home })
    c.route.push({ x: home.sill.x, z: home.sill.z, node: -1 })
    c.then = 'hide'
    c.wp = 0
    c.state = 'flee'
    this._play(c, 'run', STEP_S)
  }

  /** Free to go after a mushroom it sees: out and about its own business, with nothing in its arms. */
  _findable(c) {
    return !c.hidden && (c.state === 'walk' || c.state === 'stand' || c.state === 'gaze') && c.partner === null && c.seat === null && c.trip === '' && !this._carrying(c) && c.then !== 'pick' && c.frog === null && !this.homing
  }

  /** The node nearest (x, z), and how far it is. */
  _nodeNear(x, z) {
    const { nodes } = this.graph
    let best = -1, at = Infinity
    for (let i = 0; i < nodes.length; i++) {
      const d = Math.hypot(nodes[i].x - x, nodes[i].z - z)
      if (d < at) { at = d; best = i }
    }
    return [best, at]
  }

  /** A mushroom seen lying at the find's spot: a squeal, and a run to it off its nearest node. */
  _find(c, e) {
    this._voice(c, 'leafkinSqueal')
    this._go(c, this._nodeNear(e.fx, e.fz)[0], 'pick', [{ x: e.fx, z: e.fz }])
  }

  /** Halfway through the gather the mushroom is in its hand, taken off this client's ground where it lies within PICK_M; at the end it runs home to eat it. Picked meanwhile, and the hand closes on air. */
  _tickPick(c, dt) {
    c.hold -= dt
    if (!c.feast && c.hold <= c.dur / 2) {
      c.feast = true
      this._voice(c, 'leafkinSqueal')
      if (this.hands && this.voicing) {
        let best = null, at = PICK_M
        for (const item of this.hands.loose) {
          const d = Math.hypot(item.x - c.x, item.z - c.z)
          if (item.rec.kind === 'mushroom' && d < at) { at = d; best = item }
        }
        if (best) this.hands.lift(best)
      }
    }
    if (c.hold <= 0) this._go(c, c.home, 'enter')
  }

  /** Every still mushroom this client speaks for -- one loose here alone, or one she dropped -- found by the nearest villager free to go after it, raised for `tick`. */
  _seek(tick) {
    const tag = this.hands.tag
    for (const item of this.hands.loose) {
      if (item.rec.kind !== 'mushroom' || item.state !== 'still' || this.sought.has(item)) continue
      if (item.netId !== null && !item.netId.startsWith(`${tag}-`)) continue
      const y = this.seat(item.x, item.z)
      if (y === null || item.y - y > FIND_UP_M || this._nodeNear(item.x, item.z)[1] > FIND_ROAD_M) continue
      let best = null, at = FIND_M
      for (const c of this.all) {
        const d = Math.hypot(c.x - item.x, c.z - item.z)
        if (d < at && this._findable(c) && !this._owed(c.id, this.tick)) { at = d; best = c }
      }
      if (best === null) continue
      this.sought.add(item)
      this._raise('find', item.x, item.y, item.z, [best.id], tick)
    }
  }

  /** Free to see to a frog: out about its own business or talking, nothing in its arms and nobody waiting on it. */
  _scoldable(c) {
    return !c.hidden && (c.state === 'walk' || c.state === 'stand' || c.state === 'gaze' || c.state === 'talk') && c.frog === null && c.trip === '' && !this._carrying(c) && c.then !== 'pick' && c.then !== 'take' && !this.homing
  }

  /** Whether a villager is seeing to frog `[tx, tz, index]`. */
  _frogHeld(frog) {
    return this.all.some((c) => c.frog !== null && sameFrog(c.frog, frog))
  }

  /** Whether frog `[tx, tz, index]` is seen to already, or named by an event not yet stepped. */
  _frogTaken(frog) {
    if (this._frogHeld(frog)) return true
    for (const events of this.log.values()) for (const e of events) if (e.kind === 'frog' && !e.done && sameFrog(e.frog, frog)) return true
    return false
  }

  /** Every frog seen chasing a hob this frame and not yet seen to, raised for `tick` on the nearest villager free to see to it, where there is water near to throw it in. */
  _seeFrogs(tick) {
    for (const f of this.chases) {
      const frog = [f.tx, f.tz, f.index]
      if (this._frogTaken(frog)) continue
      let best = null, at = FROG_SEE_M
      for (const c of this.all) {
        const d = Math.hypot(c.x - f.x, c.z - f.z)
        if (d < at && this._scoldable(c) && !this._owed(c.id, this.tick)) { at = d; best = c }
      }
      if (best === null || this._shore(f.x, f.z) === null) continue
      this._raise('frog', f.x, f.y, f.z, [best.id], tick, frog)
    }
  }

  /** The nearest water to (x, z) over SHORE_BEARINGS bearings, within FROG_SHORE_M: `{ ex, ez }` the dry bank half a metre short of it, `{ wx, wz }` THROW_M past where it starts; null for none. */
  _shore(x, z) {
    let best = null, at = FROG_SHORE_M
    for (let k = 0; k < SHORE_BEARINGS; k++) {
      const a = (k / SHORE_BEARINGS) * 2 * Math.PI, ux = Math.cos(a), uz = Math.sin(a)
      for (let r = 0.25; r <= at; r += 0.25) {
        if (this.seat(x + ux * r, z + uz * r) !== null) continue
        const e = Math.max(0, r - 0.5)
        if (r < at && this.seat(x + ux * e, z + uz * e) !== null) { at = r; best = { ex: x + ux * e, ez: z + uz * e, wx: x + ux * (r + THROW_M), wz: z + uz * (r + THROW_M) } }
        break
      }
    }
    return best
  }

  /** A frog event: whoever it talks to let go, a scream at the frog, and the chase on (_tickFrog). */
  _scold(c, e) {
    const toss = this._shore(e.fx, e.fz)
    if (toss === null) return
    if (c.state === 'talk') this._untalk(c)
    this._leaveSeat(c)
    c.partner = null
    c.frog = e.frog
    c.toss = toss
    c.tossAt = null
    c.fx = e.fx
    c.fz = e.fz
    c.state = 'frog'
    c.phase = 'cry'
    c.hold = FROG_CRY_S
    c.voice = 0.2
    c.aim = this._toward(c, e.fx, e.fz)
    c.route.length = 0
    c.wp = 0
    this._voice(c, 'leafkinScream')
    this._play(c, 'threaten', FROG_CRY_S)
  }

  /** A frog's phases in turn: the scream, then the run to it; the gather, then the walk to the bank; the throw, letting go at THROW_AT; the watch, then back to its node and an errand. */
  _tickFrog(c, dt) {
    c.hold -= dt
    this._turn(c, dt)
    if (c.phase === 'throw' && c.tossAt === null && c.dur - c.hold >= THROW_AT / c.pace) c.tossAt = this.tick * TICK_S
    if (c.hold > 0) return
    switch (c.phase) {
      case 'cry':
        this._go(c, this._nodeNear(c.fx, c.fz)[0], 'grab', [{ x: c.fx, z: c.fz }])
        if (c.state === 'walk') c.phase = 'run'
        break
      case 'grab':
        c.phase = 'carry'
        // From where it stands, so the walk has a leg to keep its lane on (_off).
        c.route = [{ x: c.x, z: c.z, node: -1 }, { x: c.toss.ex, z: c.toss.ez, node: -1 }]
        c.wp = 0
        c.then = 'throw'
        c.state = 'walk'
        this._play(c, 'walk', STEP_S)
        break
      case 'throw':
        c.phase = 'watch'
        c.hold = FROG_WATCH_S
        this._play(c, 'idle', STEP_S)
        break
      case 'watch': {
        c.frog = c.toss = c.tossAt = null
        c.phase = ''
        const n = this.graph.nodes[c.at]
        this._go(c, c.at, 'errand', [{ x: n.x, z: n.z }])
        break
      }
      default: throw new Error(`Villagers: no frog phase named ${c.phase}`)
    }
  }

  /** Its hold on its frog this frame, for frogs.js: 'wait' till the gather's middle, 'held' in its fist (at the chest, a body without fingers) till THROW_AT, then 'thrown' from its reach at `t0` toward the water. */
  _claim(c) {
    const cl = c.claim, p = c.pose
    cl.heading = p.heading
    if (c.tossAt !== null) {
      cl.phase = 'thrown'
      cl.t0 = c.tossAt
      cl.from.x = c.x + Math.cos(c.heading) * 0.3
      cl.from.y = c.y + c.size
      cl.from.z = c.z - Math.sin(c.heading) * 0.3
      cl.to.x = c.toss.wx
      cl.to.z = c.toss.wz
    } else if (c.phase === 'carry' || c.phase === 'throw' || (c.phase === 'grab' && c.hold <= this.durations.gather / c.pace / 2)) {
      cl.phase = 'held'
      if (c.puppet && gripAt(c.puppet, _grip)) { cl.x = _grip.x; cl.y = _grip.y; cl.z = _grip.z }
      else { cl.x = p.x; cl.y = p.y + c.size * CHEST; cl.z = p.z }
    } else {
      cl.phase = 'wait'
      cl.x = c.fx
      cl.z = c.fz
    }
    return cl
  }

  /** Free to come to her mushroom: free to go after one, or already courting or greeting her. */
  _courtable(c) {
    return this._findable(c) || ((c.state === 'court' || c.state === 'greet') && !this.homing)
  }

  /** Free to take her mushroom: out, nothing in its arms, and not running, hurt or seated. */
  _takes(c) {
    return !c.hidden && !this._carrying(c) && c.frog === null && c.trip === '' && c.state !== 'flee' && c.state !== 'startle' && c.state !== 'pick' && c.state !== 'sit'
  }

  /** Her lure: a squeal the first time, and a creep toward her feet, planned again when she has moved REPLAN_M. */
  _court(c, e) {
    const fresh = c.state !== 'court' || c.phase === 'watch'
    c.lapse = COURT_S
    // CALM_S from her hand emptying: the last lure may be a lure's gap before.
    c.calm = CALM_S + LURE_EVERY_S + MEET_TICKS * TICK_S
    if (!fresh && Math.hypot(e.fx - c.fx, e.fz - c.fz) < REPLAN_M) return
    if (fresh) {
      if (c.state === 'greet') c.phase = ''
      this._voice(c, 'leafkinSqueal')
      c.voice = between(c.rand, FUSS_S)
    }
    c.fx = e.fx
    c.fz = e.fz
    this._toHer(c, 'court')
    if (c.state === 'walk') this._creep(c)
  }

  _creep(c) {
    c.state = 'court'
    c.phase = 'creep'
    c.hold = between(c.rand, CREEP_S)
    this._play(c, 'walk', STEP_S)
  }

  /** A route to COURT_STOP_M short of her feet (fx, fz): off the road from the node nearest her where she stands within COURT_ROAD_M of it and that spot is dry, else to the node; straight there from where it stands when that is nearer than the node. Standing there already, it arrives. */
  _toHer(c, then) {
    if (Math.hypot(c.x - c.fx, c.z - c.fz) <= COURT_STOP_M + NODE_M) {
      c.route.length = 0
      c.wp = 0
      c.then = then
      this._arrive(c)
      return
    }
    const [node, far] = this._nodeNear(c.fx, c.fz)
    const n = this.graph.nodes[node]
    let spot = null
    if (far > COURT_STOP_M && far <= COURT_ROAD_M) {
      const k = COURT_STOP_M / far
      spot = { x: c.fx + (n.x - c.fx) * k, z: c.fz + (n.z - c.fz) * k }
      if (this.seat(spot.x, spot.z) === null) spot = null
    }
    if (spot !== null && Math.hypot(c.x - spot.x, c.z - spot.z) < Math.hypot(n.x - spot.x, n.z - spot.z)) {
      this._leaveSeat(c)
      c.partner = null
      // From where it stands, so the walk has a leg to keep its lane on (_off).
      c.route = [{ x: c.x, z: c.z, node: -1 }, { x: spot.x, z: spot.z, node: -1 }]
      c.wp = 0
      c.then = then
      c.state = 'walk'
      this._play(c, 'walk', STEP_S)
      return
    }
    this._go(c, node, then, spot === null ? [] : [spot])
    // She on the road, the node is underfoot: cut the route COURT_STOP_M short, or it stands under the mushroom at her side and takes it unoffered.
    const r = c.route
    while (r.length > 0 && Math.hypot(r.at(-1).x - c.fx, r.at(-1).z - c.fz) < COURT_STOP_M) {
      const p = r.length > 1 ? r.at(-2) : c
      const d = Math.hypot(p.x - c.fx, p.z - c.fz)
      if (d <= COURT_STOP_M) { r.pop(); continue }
      const k = COURT_STOP_M / d
      r[r.length - 1] = { x: c.fx + (p.x - c.fx) * k, z: c.fz + (p.z - c.fz) * k, node: -1 }
      break
    }
    if (c.state === 'walk' && r.length === 0) this._arrive(c)
  }

  /** Creeping, a stop to beckon every CREEP_S; stopped or arrived, it fusses at her till the lure lapses, then watches her WATCH_S. */
  _tickCourt(c, dt) {
    c.lapse -= dt
    if (this.homing) { c.phase = ''; this._errand(c); return }
    if (c.phase === 'watch') {
      c.hold -= dt
      this._turn(c, dt)
      if (c.hold <= 0) { c.phase = ''; this._errand(c) }
      return
    }
    if (c.lapse <= 0) {
      c.phase = 'watch'
      c.hold = between(c.rand, WATCH_S)
      c.route.length = 0
      c.wp = 0
      c.aim = this._toward(c, c.fx, c.fz)
      this._play(c, 'idle', STEP_S)
      return
    }
    if (c.phase === 'creep') {
      c.hold -= dt
      this._follow(c, dt, TURN_RATE)
      if (c.state !== 'court' || c.phase !== 'creep' || c.hold > 0) return
      c.phase = 'pause'
      c.hold = between(c.rand, PAUSE_S)
      c.aim = this._toward(c, c.fx, c.fz)
      c.voice = 0
    }
    this._turn(c, dt)
    this._fuss(c, dt)
    if (c.phase === 'pause') {
      c.hold -= dt
      if (c.hold <= 0) this._creep(c)
    }
  }

  /** A trusted one's greeting: over to her at its gait (a friend's at a run, with a squeal), to fuss at her GREET_S. */
  _greet(c, e) {
    c.greeted = GREET_COOL_S
    c.warm = e.kind === 'hail'
    c.fx = e.fx
    c.fz = e.fz
    c.voice = 0
    if (this.voicing) this.greets++
    if (c.warm) this._voice(c, 'leafkinSqueal')
    this._toHer(c, 'greet')
    if (c.state !== 'walk') return
    c.state = 'greet'
    c.phase = 'come'
    if (c.warm) this._play(c, 'run', STEP_S)
  }

  _tickGreet(c, dt) {
    if (this.homing) { c.phase = ''; this._errand(c); return }
    if (c.phase === 'come') { this._follow(c, dt, TURN_RATE); return }
    c.hold -= dt
    this._turn(c, dt)
    this._fuss(c, dt)
    if (c.hold <= 0) { c.phase = ''; this._errand(c) }
  }

  /** Standing for her: every FUSS_S a beckon, a wave or a talk gesture, and a word with half of them (most, a friend's). */
  _fuss(c, dt) {
    c.voice -= dt
    if (c.voice > 0) return
    c.voice = between(c.rand, FUSS_S)
    if (c.rand() < (c.warm ? 0.8 : 0.5)) this._voice(c, this._chatter(c))
    const g = BECKONS[(c.rand() * BECKONS.length) | 0]
    this._play(c, g, this.durations[g] / c.pace)
  }

  /** Her mushroom into its fist: a squeal, and home at a run chattering, to eat it (residents.js `feast`). */
  _accept(c) {
    if (c.state === 'talk') this._untalk(c)
    for (const o of this.all) if (o.partner === c) o.partner = null
    c.feast = c.glad = true
    c.phase = ''
    c.voice = between(c.rand, CHATTER_S) / 2
    if (this.voicing) this.offers++
    this._voice(c, 'leafkinSqueal')
    this._go(c, c.home, 'enter')
  }

  /** Her mushrooms in hand: a lure to each villager free to come within LURE_M (again, for one courting, every LURE_EVERY_S or when she has moved), and an offer to the one it is held over. Empty-handed, a greeting to each that trusts her. Raised for `tick`. */
  _seeHer(t, tick) {
    const f = this.feet
    if (this.held.length > 0) {
      for (let i = this.held.length - 1; i >= 0; i--) {
        const lure = this.held[i]
        const c = this.all.find((o) => (o.state === 'court' || o.state === 'greet') && this._takes(o) && !this._owed(o.id, t, 'offer') && this._under(o, lure))
        if (c === undefined) continue
        this._raise('offer', lure.x, lure.y, lure.z, [c.id], tick)
        if (!this.hands.eatLure(lure)) throw new Error('Villagers: her mushroom was offered from no hand of hers')
        this.held.splice(i, 1)
        this.won.push(c.id)
      }
      if (t % MEET_TICKS !== 0 || this.held.length === 0) return
      const ids = []
      for (const c of this.all) {
        if (Math.hypot(c.x - f.x, c.z - f.z) >= LURE_M || !this._courtable(c) || this._owed(c.id, t)) continue
        if (c.state !== 'court' || c.lapse < COURT_S - LURE_EVERY_S || Math.hypot(c.fx - f.x, c.fz - f.z) >= REPLAN_M) ids.push(c.id)
      }
      if (ids.length > 0) this._raise('lure', f.x, f.y, f.z, ids.slice(0, MAX_NAMED), tick)
      return
    }
    if (t % MEET_TICKS !== 0) return
    const friend = this.all.every((c) => this.trusts(c.id))
    const ids = []
    for (const c of this.all) if (this.trusts(c.id) && c.greeted <= 0 && this._findable(c) && Math.hypot(c.x - f.x, c.z - f.z) < (friend ? FRIEND_M : GREET_M) && !this._owed(c.id, t)) ids.push(c.id)
    if (ids.length > 0) this._raise(friend ? 'hail' : 'greet', f.x, f.y, f.z, ids.slice(0, MAX_NAMED), tick)
  }

  /** Whether `lure` is held over its body or its fist as drawn this frame: within OFFER_M across, and between its feet and OFFER_UP of its size. */
  _under(c, lure) {
    const p = c.pose
    if (lure.y < p.y || lure.y > p.y + c.size * OFFER_UP) return false
    if (Math.hypot(lure.x - p.x, lure.z - p.z) <= OFFER_M) return true
    return c.puppet !== null && gripAt(c.puppet, _grip) && Math.hypot(lure.x - _grip.x, lure.z - _grip.z) <= OFFER_M
  }

  /** Ease the heading toward the aim, and report the cosine of the swing still owed, so a body half turned makes half a step. */
  _turn(c, dt, rate = TURN_RATE) {
    const s = swing(c.heading, c.aim)
    c.heading += Math.sign(s) * Math.min(Math.abs(s), rate * dt)
    return Math.max(0, Math.cos(s))
  }

  /**
   * A step along the route at the gait, carried through every point it
   * passes: a point within NODE_M is left behind where the villager stands
   * (never snapped to -- a snap every node was a lurch every 1.5 m of walk),
   * and the last left behind is the arrival; a seat's feet within SIT.near.
   */
  _follow(c, dt, rate) {
    const step = c.speed * dt
    const dodge = this._dodge(c)
    const wp0 = c.wp, d0 = Math.hypot(c.route[c.wp].x - c.x, c.route[c.wp].z - c.z)
    let left = step
    while (left > 0) {
      const p = c.route[c.wp]
      const d = Math.hypot(p.x - c.x, p.z - c.z)
      const sitting = c.then === 'sit' && c.wp >= c.route.length - 2
      if (sitting ? d <= (c.wp === c.route.length - 1 ? SIT.near : NODE_M) : this._reached(c, p, d)) {
        if (p.node >= 0) c.at = p.node
        c.wp++
        if (c.wp >= c.route.length) { c.route.length = 0; c.wp = 0; this._arrive(c); return }
        continue
      }
      c.aim = this._toward(c, p.x, p.z) + dodge
      const m = Math.min(left, d)
      const moved = m * this._turn(c, (dt * m) / step, rate)
      this._stepTo(c, c.x + Math.cos(c.heading) * moved, c.z - Math.sin(c.heading) * moved)
      left -= m
    }
    // Headway is ground gained on the point it makes for: circling someone is no headway.
    c.stall = c.wp === wp0 && d0 - Math.hypot(c.route[c.wp].x - c.x, c.route[c.wp].z - c.z) < 0.2 * step ? c.stall + dt : 0
    if (c.stall < STALL_S) return
    c.stall = 0
    if (c.state !== 'flee') { this._errand(c); return }
    // Blocked on the run, it runs from where it was blocked: planned again from the same point, the same route would block it again.
    const p = c.route[c.wp]
    c.fx = p.x
    c.fz = p.z
    this._flee(c)
  }

  /** A path's nodes as route points, each between its ends KEEP_M to the right of the way it is walked, so two meeting on a road pass without a dodge; a door is its own point, and one it stands up the steps from is the first. */
  _keepRight(c, path) {
    const { nodes } = this.graph
    const at = nodes[c.at], route = path.length > 0 && at.road === 'door' && Math.hypot(c.x - at.x, c.z - at.z) > NODE_M ? [{ x: at.x, z: at.z, node: c.at }] : []
    return route.concat(path.map((k, i) => {
      const n = nodes[k]
      if (i === 0 || i === path.length - 1 || n.road === 'door') return { x: n.x, z: n.z, node: k }
      const a = nodes[path[i - 1]], b = nodes[path[i + 1]], L = Math.hypot(b.x - a.x, b.z - a.z) || 1
      // Right of the way (ux, uz) is (uz, -ux): the dodge's side, +90° of the heading.
      return { x: n.x + (KEEP_M * (b.z - a.z)) / L, z: n.z - (KEEP_M * (b.x - a.x)) / L, node: k }
    }))
  }

  _space(c, o) { return (SPACE_M * (c.size + o.size)) / (2 * SIZE_M) }

  /** The veer off its route this tick: away from the nearest body within LOOK_M ahead on its bearing to the point it makes for (never its heading, which the veer itself turns) and within its space of that line, to its right when dead ahead -- so two meeting head on both go right and pass -- but inward at the lane's edge. */
  _dodge(c) {
    const p = c.route[c.wp], b = this._toward(c, p.x, p.z), fx = Math.cos(b), fz = -Math.sin(b)
    let dodge = 0, nearest = LOOK_M
    for (const o of this.all) {
      if (o === c || o.hidden) continue
      const dx = o.x - c.x, dz = o.z - c.z
      const fwd = dx * fx + dz * fz
      if (fwd <= 0 || fwd >= nearest) continue
      const lat = fx * dz - fz * dx, space = this._space(c, o)
      if (Math.abs(lat) >= space) continue
      nearest = fwd
      dodge = (lat >= 0 ? 1 : -1) * DODGE * (1 - fwd / LOOK_M) * (1 - Math.abs(lat) / space)
    }
    // Never out past the lane: at its edge it veers inward instead, (fz, -fx) being +90° of the bearing.
    const k = Math.sign(dodge)
    if (k !== 0 && this._off(c, c.x + k * 0.3 * fz, c.z - k * 0.3 * fx) > LANE_M) dodge = -dodge
    return dodge
  }

  /** A route point d off is reached within NODE_M, or when pressed against whoever stands on it. */
  _reached(c, p, d) {
    if (d <= NODE_M) return true
    for (const o of this.all) {
      if (o === c || o.hidden) continue
      const q = Math.hypot(o.x - p.x, o.z - p.z), space = this._space(c, o)
      if (q < space + NODE_M && d <= space + q + 0.05 && Math.hypot(o.x - c.x, o.z - c.z) <= space + 0.05) return true
    }
    return false
  }

  /**
   * Onto (x, z), or round whoever is in the way: a step into someone's space
   * slides along their rim at its full length, to the side it already leans
   * (the dodge's side when dead on), else the other side, else not at all,
   * and never back the way it came, out to PART_M of the way; it keeps that
   * side (`side`) until a step goes clear, or it would circle.
   */
  _stepTo(c, x, z) {
    if (this._free(c, x, z)) { c.x = x; c.z = z; c.side = 0; return }
    let o = null, near = Infinity
    for (const q of this.all) {
      if (q === c || q.hidden) continue
      const d = Math.hypot(x - q.x, z - q.z)
      if (d < this._space(c, q) && d < Math.hypot(c.x - q.x, c.z - q.z) && d < near) { near = d; o = q }
    }
    if (o === null) return
    const space = this._space(c, o), sx = x - c.x, sz = z - c.z, L = Math.hypot(sx, sz)
    let nx = c.x - o.x, nz = c.z - o.z
    const n = Math.hypot(nx, nz) || 1
    nx /= n; nz /= n
    // Dead on, the dodge's side: (-sin h, -cos h), +90° of the heading.
    const lean = sx * -nz + sz * nx
    const side = c.side || (Math.abs(lean) > 1e-6 * L ? Math.sign(lean) : nz * Math.sin(c.heading) - nx * Math.cos(c.heading) >= 0 ? 1 : -1)
    for (const k of [side, -side]) {
      if (k * lean < -0.1 * L) continue
      let px = c.x - k * nz * L, pz = c.z + k * nx * L
      const d = Math.hypot(px - o.x, pz - o.z)
      if (d < space) { px = o.x + ((px - o.x) / d) * space; pz = o.z + ((pz - o.z) / d) * space }
      if (this._free(c, px, pz, PART_M)) { c.x = px; c.z = pz; c.side = k; return }
    }
  }

  /**
   * Whether it may step to (x, z): no nearer anyone whose space that is in (a
   * step away is let through, so two put together part), within LANE_M of its
   * leg or the roads (`lane`; PART_M while parting) unless nearer them than
   * it was, and on ground it can stand on.
   */
  _free(c, x, z, lane = LANE_M) {
    let parting = false
    for (const o of this.all) {
      if (o === c || o.hidden) continue
      const space = this._space(c, o), was = Math.hypot(c.x - o.x, c.z - o.z)
      if (Math.hypot(x - o.x, z - o.z) < space - 1e-9 && Math.hypot(x - o.x, z - o.z) < was) return false
      if (was < space) parting = true
    }
    const off = this._off(c, x, z)
    if (off > (parting ? PART_M : lane) && off > this._off(c, c.x, c.z)) return false
    return this.seat(x, z) !== null
  }

  /** How far (x, z) lies from the leg of its route it walks (its first point, before it has one: a riser's way off its stool), or from the roads if they are nearer. */
  _off(c, x, z) {
    const seg = (a, b) => {
      const ux = b.x - a.x, uz = b.z - a.z, L = ux * ux + uz * uz
      const t = L > 0 ? Math.max(0, Math.min(1, ((x - a.x) * ux + (z - a.z) * uz) / L)) : 0
      return Math.hypot(x - a.x - t * ux, z - a.z - t * uz)
    }
    let off = c.wp < c.route.length ? seg(c.route[Math.max(0, c.wp - 1)], c.route[c.wp]) : Infinity
    if (off <= LANE_M) return off
    const { nodes, adj } = this.graph
    for (let i = 0; i < nodes.length; i++) for (const j of adj[i]) if (j > i) off = Math.min(off, seg(nodes[i], nodes[j]))
    return off
  }

  /** Someone else passing within TALK_M, with neither just out of a talk, on its way to a stool or about the forage trip's business. */
  _meet(c) {
    const busy = (o) => o.talked > 0 || o.seat !== null || o.partner !== null || o.feast || o.trip !== '' || o.frog !== null
    if (this.homing || busy(c)) return null
    for (const o of this.all) {
      if (o === c || o.hidden || busy(o) || (o.state !== 'walk' && o.state !== 'stand')) continue
      if (Math.hypot(o.x - c.x, o.z - c.z) <= TALK_M) return o
    }
    return null
  }

  _tick(c, tick) {
    c.px = c.x; c.py = c.y; c.pz = c.z; c.ph = c.heading
    const dt = TICK_S
    c.talked = Math.max(0, c.talked - dt)
    if (this._startlable(c)) {
      const e = this._eventOf(c, 'startle')
      if (e) this._startle(c, e)
    }
    c.greeted = Math.max(0, c.greeted - dt)
    c.calm = Math.max(0, c.calm - dt)
    if (this._takes(c) && this._eventOf(c, 'offer')) this._accept(c)
    if (this._findable(c)) {
      const e = this._eventOf(c, 'find')
      if (e) this._find(c, e)
    }
    if (this._scoldable(c)) {
      const e = this._eventOf(c, 'frog')
      if (e && !this._frogHeld(e.frog)) this._scold(c, e)
    }
    if (this._courtable(c)) {
      const e = this._eventOf(c, 'lure')
      if (e) this._court(c, e)
    }
    if (this._findable(c) && c.greeted <= 0) {
      const e = this._eventOf(c, 'greet') ?? this._eventOf(c, 'hail')
      if (e) this._greet(c, e)
    }
    if ((c.frog !== null && c.phase !== 'cry') || c.glad) {
      c.voice -= dt
      if (c.voice <= 0) { c.voice = between(c.rand, CHATTER_S); this._voice(c, this._chatter(c)) }
    }
    // Homing, every hold runs out and every walker runs for its door (_errand, _go); a forager away stays out past the turn, and one seeing to a frog finishes first.
    if (this.homing && c.state !== 'inside' && c.state !== 'away' && c.frog === null) {
      c.hold = Math.min(c.hold, 0)
      if (c.state === 'walk' && c.clip !== 'run') this._go(c, c.home, 'enter')
    }
    switch (c.state) {
      case 'inside':
        c.hold -= dt
        if (c.hold <= 0 && !this.homing && !this.all.some((o) => o !== c && !o.hidden && Math.hypot(o.x - c.x, o.z - c.z) < this._space(c, o))) this._exit(c)
        break
      case 'walk':
        // Called for a mushroom by a giver since gone on, it goes about its own business.
        if (c.then === 'take' && c.partner === null) { this._errand(c); break }
        if (tick % MEET_TICKS === 0) {
          if (c.then === 'take' && c.partner.state === 'give' && Math.hypot(c.partner.x - c.x, c.partner.z - c.z) <= TALK_M) { this._gift(c.partner, c); break }
          if (c.bundle > 0 && !this.homing) { this._look(c); if (c.state === 'give') break }
          const o = this._meet(c)
          if (o) { this._talk(c, o); break }
        }
        this._follow(c, dt, TURN_RATE)
        break
      case 'stand':
        c.hold -= dt
        if (tick % MEET_TICKS === 0 && c.then === 'take' && c.partner !== null && c.partner.state === 'give' && Math.hypot(c.partner.x - c.x, c.partner.z - c.z) <= TALK_M) { this._gift(c.partner, c); break }
        if (tick % MEET_TICKS === 0 && c.bundle > 0 && !this.homing) { this._look(c); if (c.state === 'give') break }
        if (c.hold <= 0) this._errand(c)
        break
      case 'give': {
        c.hold -= dt
        const t = this._taker(c)
        if (t !== null) {
          c.aim = this._toward(c, t.x, t.z)
          this._turn(c, dt)
        }
        if (tick % MEET_TICKS === 0 && !this.homing) this._look(c)
        if (t === null || c.hold <= 0 || this.homing) {
          for (const o of this.all) if (o.partner === c) o.partner = null
          this._errand(c)
        }
        break
      }
      case 'away':
        c.hold -= dt
        if (c.hold <= 0 && !this.homing) this._back(c)
        break
      case 'gaze':
        c.hold -= dt
        this._turn(c, dt)
        if (c.hold <= 0) this._go(c, c.at, 'errand')
        break
      case 'sit':
        if (c.phase === 'turn') {
          this._turn(c, dt)
          if (Math.abs(swing(c.heading, c.aim)) < 0.02) this._phase(c, 'down')
        } else if (c.phase === 'hold') {
          c.hold -= dt
          if (c.hold <= 0) this._phase(c, 'up')
        }
        break
      case 'talk':
        c.hold -= dt
        c.aim = this._toward(c, c.partner.x, c.partner.z)
        this._turn(c, dt)
        c.voice -= dt
        if (c.voice <= 0) {
          c.voice = between(c.rand, CHATTER_S)
          this._voice(c, this._chatter(c))
          const gesture = TALKS[(c.rand() * TALKS.length) | 0]
          this._play(c, gesture, this.durations[gesture])
        }
        if (c.hold <= 0) { this._untalk(c); this._done(c) }
        break
      case 'startle':
        c.hold -= dt
        this._turn(c, dt, FLEE_TURN)
        if (c.hold <= 0) this._flee(c)
        break
      case 'pick': this._tickPick(c, dt); break
      case 'frog': this._tickFrog(c, dt); break
      case 'court': this._tickCourt(c, dt); break
      case 'greet': this._tickGreet(c, dt); break
      case 'flee':
        c.voice -= dt
        if (c.voice <= 0) this._call(c, 'leafkinWhimper', WHIMPER_S)
        this._follow(c, dt, FLEE_TURN)
        break
      default: throw new Error(`Villagers: no state named ${c.state}`)
    }
    c.left -= dt
    if (c.left <= 0) this._step(c)
    // From its own feet, so a house's awning or roof overhead is not ground it is lifted onto.
    c.y = this.walk.heightAt(c.x, c.z, c.y)
    // Its seated underside onto the stool's top (seatY) and off again, eased over the clip's own cuts so it neither pops at the contact nor stands lifted while it turns.
    if (c.state === 'sit') {
      const on = c.phase === 'hold' ? 1 : c.phase === 'down' ? 1 - c.left / c.dur : c.phase === 'up' ? c.left / c.dur : 0
      c.y += Math.min(1, Math.max(0, on)) * (c.seat.top - this.sitY * c.k - c.y)
    }
  }

  // -------------------------------------------------------------------------
  // The frame.
  // -------------------------------------------------------------------------

  _takePuppet(c) {
    if (!c.puppet) {
      const p = this.freePuppets.pop()
      if (!p) { this.starved++; return null }
      c.puppet = p
      this.batch.add(p.group)
      // The clip at its pace, so the feet cover the ground the speed does, and as far into the step as the tick is.
      p.mixer.timeScale = c.pace
      p.play(c.clip, c.cue, Math.max(0, c.from) + (c.dur - c.left) * c.pace)
    }
    return c.puppet
  }

  _releasePuppet(c) {
    const p = c.puppet
    if (!p) return
    p.release()
    this.batch.remove(p.group)
    this.freePuppets.push(p)
    c.puppet = null
  }

  /**
   * One frame. `feet` is where she stands and `head` her eyes, `seconds` the
   * world clock (clock.js WorldClock.seconds) and `dt` the frame's own time,
   * for the puppets. The first frame places everyone at the chapter's start
   * and replays it in one go, as does a clock skip past a chapter; a shorter
   * skip is caught up in one frame too, silent. A startle heard late is
   * stepped again from the last state kept before it. `lures` are this
   * frame's (hands.js lures), and `trusts(id)` whether villager `id` trusts
   * her (trust.js).
   */
  update(feet, head, seconds, dt, chases = NO_CHASES, lures = NO_LURES, trusts = NOBODY) {
    if (!this.loaded) return
    this.chases = chases
    this.trusts = trusts
    this.held.length = 0
    if (this.hands) for (const l of lures) if (l.by === null && l.kind === 'mushroom') this.held.push(l)
    this.frame++
    this.feet.x = feet.x; this.feet.y = feet.y; this.feet.z = feet.z
    this.head.x = head.x; this.head.y = head.y; this.head.z = head.z
    const tick = tickOf(seconds)
    this.rolled = false
    this.rewound = 0
    if (this.tick === null || tick - this.tick > CHAPTER_S * TICK_HZ) this._placeAll(seconds)
    else if (this.rewind <= this.tick) {
      const a = (seconds - this.tick * TICK_S) * TICK_HZ
      for (const c of this.all) if (c.shown) keepWas(c, a, c.py + (c.y - c.py) * a)
      this.rewound = this.tick - this.rewind
      this.maxRewind = Math.max(this.maxRewind, this.rewound)
      this._rollback()
      this.rolled = true
    }
    this.rewind = Infinity
    const live = this.live
    for (let t = this.tick + 1; t <= tick; t++) this._stepAll(t, tick)
    this.alpha = Math.min(1, Math.max(0, (seconds - this.tick * TICK_S) * TICK_HZ))
    for (const c of this.all) this._draw(c, dt, seconds)
    this.claims.clear()
    for (const c of this.all) if (c.frog !== null && !c.hidden) this.claims.set(frogKey(...c.frog), this._claim(c))
    if (tick - live > SILENT_TICKS) this.calls.length = 0
  }

  /** Tick `t` for the whole village, `target` the frame's: the chapter's turn puts everyone indoors; a live tick near the frame's looks for her feet first. */
  _stepAll(t, target) {
    if (t >= this.turnTick) {
      if (t > this.live) for (const c of this.all) if (!c.hidden) this.popped++
      this._placeAll(t / TICK_HZ)
      this.live = Math.max(this.live, t)
      return
    }
    this.tick = t
    this.voicing = t > this.live
    this.homing = t >= this.turnTick - HOMING_S * TICK_HZ
    if (this.voicing && t > target - SILENT_TICKS) {
      // A mushroom in her hand startles nobody, nor do her feet anyone that trusts her, is coming to her, or was lured within CALM_S of now.
      const ids = []
      if (this.held.length === 0) for (const c of this.all) if (this._startlable(c) && !this.trusts(c.id) && c.state !== 'court' && c.state !== 'greet' && c.calm <= 0 && Math.hypot(c.x - this.feet.x, c.y - this.feet.y, c.z - this.feet.z) < STARTLE_M && !this._owed(c.id, t, 'startle')) ids.push(c.id)
      if (ids.length > 0) this._flinch(this._raise('startle', this.feet.x, this.feet.y, this.feet.z, ids.slice(0, MAX_NAMED), t + LEAD_TICKS))
      this._seeHer(t, t + LEAD_TICKS)
      if (this.hands && t % MEET_TICKS === 0) this._seek(t + LEAD_TICKS)
      if (t % MEET_TICKS === 0) this._seeFrogs(t + LEAD_TICKS)
    }
    for (const c of this.all) this._tick(c, t)
    const events = this.log.get(t)
    if (events) for (const e of events) e.done = true
    this.live = Math.max(this.live, t)
    this.voicing = false
    if (t % SNAP_TICKS === 0) this._snap()
  }

  _startlable(c) { return c.state !== 'inside' && c.state !== 'away' && c.state !== 'startle' && c.state !== 'flee' }

  /** Whether an event (of `kind`, or any) already names villager `id` on tick `t` (stepped after this looks) or one her lead could reach. */
  _owed(id, t, kind = null) {
    for (let k = t; k <= t + LEAD_TICKS; k++) if (this.log.get(k)?.some((e) => (kind === null || e.kind === kind) && e.ids.includes(id))) return true
    return false
  }

  /** Her startle `e` whimpered now, or screamed by a carrier, where the room hears it LEAD_TICKS on, and each villager's own first cry hushed on this client. */
  _flinch(e) {
    for (const id of e.ids) {
      const c = this.all[id]
      this.calls.push({ sound: this._carrying(c) ? 'leafkinScream' : 'leafkinWhimper', x: c.x, y: c.y + c.size * CHEST, z: c.z })
      this.hushed.set(id, e.tick + TICK_HZ)
    }
  }

  /** The village's state as it stands, kept for a rollback. */
  _snap() {
    this.snaps.push({
      tick: this.tick,
      rows: this.all.map((c) => ({ kept: KEPT.map((f) => c[f]), route: c.route.slice(), partner: c.partner === null ? -1 : c.partner.id, seat: c.seat === null ? -1 : this.seats.indexOf(c.seat) })),
    })
    if (this.snaps.length > SNAPS) this.snaps.shift()
  }

  /** Back to the last state kept before the startle heard late, or the chapter's start if none is. */
  _rollback() {
    this.rewinds++
    while (this.snaps.length > 0 && this.snaps[this.snaps.length - 1].tick >= this.rewind) this.snaps.pop()
    const s = this.snaps[this.snaps.length - 1]
    if (!s) { this._placeAll(this.tick / TICK_HZ); return }
    this.tick = s.tick
    for (const seat of this.seats) seat.by = null
    this.all.forEach((c, i) => {
      const row = s.rows[i]
      const clip = c.clip
      KEPT.forEach((f, k) => { c[f] = row.kept[k] })
      c.route = row.route.slice()
      c.partner = row.partner < 0 ? null : this.all[row.partner]
      c.seat = row.seat < 0 ? null : this.seats[row.seat]
      if (c.seat !== null) c.seat.by = c
      // A clip the rollback changed is started afresh, the puppet reading a new cue.
      if (c.clip !== clip) c.cue++
    })
  }

  // -------------------------------------------------------------------------
  // The room: her startles out, the others' in (creature-net.js).
  // -------------------------------------------------------------------------

  /** This client's events since the last call, as anchors `[key, T, fx, fy, fz, 0, 0, kind, null, ...ids]`, drained. */
  pending(into) {
    for (const a of this.outbox) into.push(a)
    this.outbox.length = 0
    return into
  }

  /** The villagers she has fed since the last call, by id, drained: each trusts her now (trust.js). */
  befriended(into) {
    for (const id of this.won) into.push(id)
    this.won.length = 0
    return into
  }

  /** Someone's event of a PREFIX kind: logged, and stepped again from before it if this client is past it. Another village's, one before the chapter or one already logged is let go. */
  apply(a) {
    if (typeof a[0] !== 'string' || !a[0].startsWith(this.wire) || !Object.hasOwn(PREFIX, a[7])) return
    const tick = Math.round(a[1] * TICK_HZ)
    const ids = a[7] === 'frog' ? a.slice(9, 10) : a.slice(9)
    const frog = a[7] === 'frog' ? a.slice(10) : null
    if (frog !== null && (frog.length !== 3 || !frog.every(Number.isInteger))) throw new Error(`Villagers: a frog naming no frog ${JSON.stringify(a)}`)
    if (![tick, a[2], a[3], a[4]].every(Number.isFinite) || ids.length === 0) throw new Error(`Villagers: a malformed ${a[7]} ${JSON.stringify(a)}`)
    if (!ids.every((id) => Number.isInteger(id) && id >= 0 && id < this.all.length)) throw new Error(`Villagers: a ${a[7]} names villagers this village has not: ${JSON.stringify(a)}`)
    if (this.tick !== null && tick <= tickOf(chapterOf(this.tick / TICK_HZ, this.key).start)) return
    const e = { key: a[0], kind: a[7], tick, fx: a[2], fy: a[3], fz: a[4], ids, frog, by: a[8], done: false }
    if (this._log(e) !== e) return
    if (this.tick !== null && tick <= this.tick) this.rewind = Math.min(this.rewind, tick)
  }

  /** The frame's pose between the last two ticks, and the puppet on it. */
  _draw(c, dt, seconds) {
    if (c.hidden && !c.puppet) {
      c.shown = false
      if (c.carrier !== null) { c.carrier.release(); c.carrier = null }
      return
    }
    const a = this.alpha
    const pose = c.pose
    const wasX = pose.x, wasY = pose.y, wasZ = pose.z
    ease(c, pose, c.px + (c.x - c.px) * a, c.py + (c.y - c.py) * a, c.pz + (c.z - c.pz) * a, c.ph + swing(c.ph, c.heading) * a, this.rolled, dt)
    const m = c.shown ? popM(pose, wasX, wasY, wasZ, dt) : 0
    if (m > 0) warnPop(this, seconds, { id: c.id, state: c.state, m: +m.toFixed(2), dy: +(pose.y - wasY).toFixed(2), rewound: this.rewound })
    c.shown = !c.hidden
    pose.k = c.k
    pose.size = c.size
    pose.speed = c.speed
    pose.clip = c.clip
    pose.cycle = c.cycle

    const dist = Math.hypot(pose.x - this.head.x, pose.y - this.head.y, pose.z - this.head.z)
    c.lod = critterTier(c.size, dist, c.lod, LOD_TIERS)
    const want = c.hidden || c.lod === LOD_TIERS ? -1 : c.lod
    const puppet = want === -1 && !c.puppet ? null : this._takePuppet(c)
    if (puppet) {
      // Through its door it dithers out where it stands, over DOOR_FADE_S.
      puppet.show(want, c.hidden ? DOOR_FADE_S : lodFadeS())
      _pos.set(pose.x, pose.y, pose.z)
      _quat.setFromAxisAngle(UP, pose.heading)
      _scl.setScalar(c.k)
      _mat.compose(_pos, _quat, _scl)
      puppet.play(c.clip, c.cue, c.from)
      groundFeet(puppet, pose, this.walk, PLANTED, (this.frame + c.id) % 6 === 0)
      puppet.step(dt)
      puppet.group.matrix.copy(_mat)
      puppet.group.matrixWorldNeedsUpdate = true
    }
    if (this.hands) this._carry(c)
    if (puppet?.done) this._releasePuppet(c)
  }

  /** Its arms this frame, read off the tick's state so a rollback redraws them: the bundle it gives from, or the one mushroom it takes home in its fist, carried through its door while it dithers out. A startled one drops what it held. */
  _carry(c) {
    const want = c.lod === LOD_TIERS || (c.hidden && !c.puppet) ? 0 : c.trip === 'back' ? c.bundle : c.feast ? 1 : 0
    const had = c.carrier === null ? 0 : c.carrier.count()
    if (want === 0) {
      if (had === 0) return
      if (c.state === 'startle' || c.state === 'flee') c.carrier.scatter()
      c.carrier.release()
      c.carrier = null
      return
    }
    if (want !== had) {
      if (c.carrier === null) {
        if (this.hands.carriers >= CARRIERS) return
        c.carrier = this.hands.carry(c.key, c.size * CARRY_SPAN)
      }
      c.carrier.clear()
      for (let i = 0; i < want; i++) c.carrier.add(this.mushrooms.record(hash32(this.seed, c.id, i)), this.mushrooms)
    }
    if (want === 1 && c.puppet && gripAt(c.puppet, _grip)) c.carrier.grip(_grip.x, _grip.y, _grip.z, c.pose.heading)
    else c.carrier.place(c.pose.x, c.pose.y, c.pose.z, c.pose.heading, c.size * CHEST)
  }

  dispose() {
    for (const c of this.all) if (c.carrier !== null) c.carrier.release()
    for (const c of this.all) this._releasePuppet(c)
    this.batch.parent?.remove(this.batch)
    for (const m of this.materials) m.dispose()
    this.asset?.map?.dispose()
    for (const geo of this.asset?.tiers ?? []) geo.dispose()
  }
}
