// ---------------------------------------------------------------------------
// THE ABOMINABLE SNOWMEN: one per 40,000 square metres of ground above the snow
// line, wood or open, two to six metres tall, and not one of them moves until
// a player does.
//
// PLACEMENT IS THE WILDLIFE'S: a pure function of position (critters.js
// tileSeed), a seat on the WalkSurface -- so one stands where she could stand,
// off the water, off the crags, out of the trunks -- and above the snow line
// where the wildlife will not go. There is no tether, because a snowman that
// has noticed a player does not stay in its tile: a tile that unloads leaves
// its snowmen LOOSE under their own keys, a follower walking on, and the tile
// that re-enters takes its loose snowman back. A loose one is freed only once
// it is out past the tile horizon, by which time the ladder has dissolved it
// out; nothing is ever switched off.
//
// TIME IS THE ROOM'S CLOCK (sim/score.js, _notes/creature-sync.md): every
// snowman steps at TICK_HZ on absolute ticks of world time, and everything it
// rolls is hashed from its key and a tick, so every client in the room sees the
// same one doing the same thing. A standing one's gesture is closed-form in
// (key, tick): its minute's chain of gestures, rolled from the minute's own
// dice, so a joiner needs no history to know what it is doing.
//
// THE BEHAVIOUR IS FOUR STATES AND A PLAYER'S DISTANCE.
//
//   cower   What one is found doing, at home: crouched and flinching, over and
//           over, at nothing you can see. It faces wherever it faced when the
//           tile rolled it, and it notices her only when she steps inside
//           NOTICE_M of it on the side it faces -- she can walk up behind it --
//           and then it goes LIVE on her: this client is its authority and
//           tells the room (an anchor every ANCHOR_S), and every peer runs the
//           same rule against her relayed head. A peer's snowman notices a
//           player only by that player's anchor, never on its own reading of a
//           lagged head, so no two clients disagree about who it is watching.
//   watch   Turned to its player and keeps turning to them, and beckons, or
//           nods, or points, or shrugs, or just stands and looks. `near` is
//           the closest they have come since it noticed them; the moment they
//           are AWAY_M further off than that, it --
//   follow  -- comes after them: walking when they are close, running when
//           they are not, stopping STANDOFF_M short to gesture again and
//           starting again the moment they open the gap. Ground it cannot
//           cross -- water, a trunk, a face past FOLLOW_SLOPE, which is
//           steeper than she can climb, so no ground she crossed stops it --
//           turns it aside for a DETOUR_S, then it aims at them again; the
//           snow line does not stop it. Past FORGET_M, or the player gone
//           from the room, or (a peer's) no anchor for ANCHOR_STALE_S, it
//           forgets them: the authority sends one last `rejoin` anchor, and --
//   home    -- it walks home the way it followed, skirting what it cannot
//           cross, and cowers there. At the chapter turn (CHAPTER_S) one still
//           on its way is put home, so a joiner past the relay's memory of its
//           anchor lays it where every resident has it.
//
// The clips are the human library (tools/creatures/anim/clips/human), every
// one of which starts and ends on the same stance, so any of them chains to any
// other with a FADE_S crossfade and a gesture is always played in whole cycles.
// It turns at TURN_RATE and never snaps, and it makes ground only the way it
// faces, like the wildlife. It is drawn as the wildlife is: a puppet
// (render/puppet.js) standing on the world vertical whatever the ground under
// it does, over the shipped ladder, dissolving between the world's
// rungs (critters.js critterTier), which are a ratio of its OWN height -- a 2 m
// one steps down at 9 m where a 6 m one holds to 27. Its rung is a drawing
// matter only: a snowman is minded on every rung and past the last.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { lerp, mulberry32 } from '../../sim/mathx.js'
import { CATCH_UP_TICKS, CHAPTER_S, TICK_HZ, TICK_S, chapterOf, hash32, keyHash, stepTo, swing, tickAfter, tickOf } from '../../sim/score.js'
import { CRITTER_GLB, LOD_RUNGS, critterTier, tileSeed, walkTiles } from './critters.js'
import { Puppet, groundFeet, loadSkinnedAsset, makePuppetMaterials, makeSettledMaterial } from './puppet.js'

export const TILE = 32
export const RADIUS = 96
// Snowmen per square metre of ground above the snow line: one per 40,000.
export const DENSITY = 1 / 40000
// Skinned tiers, one per rung of the world ladder (critters.js LOD_RUNGS). A snowman's size is its height, which is its largest extent, so a 6 m one steps down at 27, 54 and 108 m and is culled past 216 -- further off than a tile of it is ever loaded, so in practice only the smallest are culled by the ladder rather than by their tile.
export const LOD_TIERS = LOD_RUNGS
// Under one is expected in RADIUS; every one of them is in sight, so there is a puppet a slot.
export const MAX = 16
export const PUPPETS = 16

// How tall one is, rolled evenly between the two.
export const SIZE_M = [2, 6]
// Ground one is not placed on: steeper than this, or anywhere under the snow line.
export const MAX_SLOPE = (35 * Math.PI) / 180
// Ground a following one will not step onto. Past her own limit (player.js
// LOCOMOTION.maxSlopeDeg, 50), read over the same 1.5 m the walk surface's
// normalAt spans, so a shelf she walked over never stands between them.
export const FOLLOW_SLOPE = (55 * Math.PI) / 180
// She is noticed only inside a half-disc of this radius AHEAD of a cowering snowman; behind or beside it she can stand at arm's length.
export const NOTICE_M = 10
// A watching snowman follows once its player is this much further off than the closest they came.
export const AWAY_M = 3
// A following snowman stops this short of its player, and sets off again once they are RESUME_M past that.
export const STANDOFF_M = 4
export const RESUME_M = 1.5
// Beyond this it runs rather than walks after them.
export const RUN_M = 12
// Beyond this, in any state, it forgets them.
export const FORGET_M = 80
// Within this of home a walker home is home.
export const HOME_M = 1
// How long a blocked probe turns it off its line before it aims at its mark again, and how long a clear line must run before it may pick the other side to skirt by -- so a lake is gone round one way, not dithered at.
const DETOUR_S = 1.5
const SIDE_S = 4
// A live snowman's authority sends its anchor this often; a peer's snowman with none this old forgets its player.
export const ANCHOR_S = 1
export const ANCHOR_STALE_S = 3
// Over which a peer's snowman wears off the error an anchor finds in it.
export const CORRECT_S = 1

// Radians a second a body may swing.
export const TURN_RATE = 1.4
// Body heights ahead the next step is tested at, and every how many ticks, staggered across the snowmen by key.
const AHEAD = 0.75
const PROBE_EVERY = 3
// Frames between a standing puppet's foot re-plants, staggered by slot.
const REPLANT_EVERY = 6
// Seconds one clip takes to give way to the next.
const FADE_S = 0.25

// What a cowering snowman does, by weight, and how many cycles of it; `idle` between is a still crouch's worth of standing.
export const COWER_ACTS = [['cower', 7], ['recoil', 2], ['idle', 1]]
const COWER_CYCLES = [1, 3]
// What a watching one does, by weight -- a stare, or a gesture at its player -- and how long a stare holds.
export const WATCH_ACTS = [['idle', 4], ['beckon', 4], ['talk-gesture', 2], ['talk-point', 2], ['talk-nod', 1], ['talk-shrug', 1]]
const STARE_S = [2, 5]
// A standing snowman's gestures are chained per segment this long, the segment's last cut at its end; each table has its own dice.
const GESTURE_SEG_S = 60
const GRID_TICKS = GESTURE_SEG_S * TICK_HZ
const TABLE_ID = new Map([[COWER_ACTS, 1], [WATCH_ACTS, 2]])

// Every clip the shipped file must carry; the layer plays these, the file carries the whole human library.
export const CLIPS = ['idle', 'walk', 'run', 'cower', 'recoil', 'beckon', 'talk-gesture', 'talk-point', 'talk-nod', 'talk-shrug']
// The clips whose two feet stay put, so a standing one's feet are put on the
// ground under each (puppet.js FootIK). Measured off the shipped clips: a
// recoil steps a foot back, and no gait is planted.
export const PLANTED = new Set(['idle', 'cower', 'beckon', 'talk-gesture', 'talk-point', 'talk-nod', 'talk-shrug'])

const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()
const ticksOf = (s) => Math.max(1, Math.round(s * TICK_HZ))
/** One name out of (name, weight) pairs. */
function weighted(rand, pairs) {
  let roll = rand() * pairs.reduce((sum, p) => sum + p[1], 0)
  for (const [name, w] of pairs) if ((roll -= w) < 0) return name
  return pairs[pairs.length - 1][0]
}

const UP = new THREE.Vector3(0, 1, 0)
const _quat = new THREE.Quaternion()
const _pos = new THREE.Vector3()
const _scl = new THREE.Vector3()
const _mat = new THREE.Matrix4()
const _trunk = { x: 0, z: 0, r: 0 }
const _norm = { x: 0, y: 1, z: 0 }
const _gesture = { clip: '', start: 0, end: 0 }
const _her = { x: 0, y: 0, z: 0, by: null }

/**
 * The shipped snowman (tools/creatures/ship-biped.mjs): the ladder, the
 * skeleton, the clips and the colour map as render/puppet.js wants them, plus
 * the shipper's `biped` extras spread on top -- the turned body's height, which
 * is what a snowman's size is measured against, and each gait's ground speed in
 * the file's own units.
 */
export async function loadBipedGlb(url) {
  const asset = await loadSkinnedAsset(url, { tiers: LOD_TIERS, clips: CLIPS, extras: 'biped' })
  if (!(asset.extras.height > 0)) throw new Error(`${url}: no turned height in its extras -- re-ship it`)
  if (asset.extras.legs?.length !== 2) throw new Error(`${url}: no two legs in its extras -- re-ship it`)
  return { ...asset, ...asset.extras }
}

export class Snowmen {
  /**
   * @param height  V2Height: snowLineAt
   * @param water   WaterSurfaces: isSubmerged
   * @param opts.walk   WalkSurface: heightAt, normalAt, obstacleAt. The ground she walks is the ground they walk.
   * @param opts.asset  a loaded asset, for a gate; the world fetches the GLB
   */
  constructor(scene, height, water, { seed = 1, walk, asset = null } = {}) {
    if (!height || typeof height.snowLineAt !== 'function') throw new Error('Snowmen needs a height field with snowLineAt')
    if (!water || typeof water.isSubmerged !== 'function') throw new Error('Snowmen needs WaterSurfaces, for isSubmerged')
    if (!walk || typeof walk.heightAt !== 'function' || typeof walk.normalAt !== 'function' || typeof walk.obstacleAt !== 'function') {
      throw new Error('Snowmen needs the WalkSurface, for heightAt, normalAt and obstacleAt')
    }
    this.height = height
    this.water = water
    this.walk = walk
    this.seed = seed

    this.batch = new THREE.Group()
    this.batch.name = 'v2-snowmen'
    scene.add(this.batch)
    // ONE settled material for the lot and a fade pair per puppet, so a frame of
    // drawn snowmen is one material change and not one each; no snowman wears a
    // colour of its own, and puppet.js makePuppetMaterials says why. `materials`
    // is the flat list the world's lighting patches.
    this.plain = makeSettledMaterial('snowmen')
    this.materials = [this.plain]
    this.puppetMats = []
    for (let i = 0; i < PUPPETS; i++) {
      const mats = makePuppetMaterials('snowmen', this.plain)
      this.puppetMats.push(mats)
      this.materials.push(mats.in, mats.out)
    }
    this.slots = []
    for (let i = 0; i < MAX; i++) {
      this.slots.push({
        id: i, tile: null, key: '', hash: 0, loose: false,
        // The pose the frame draws, between the last tick's (s) and the one before it (l).
        x: 0, y: 0, z: 0, heading: 0, sx: 0, sy: 0, sz: 0, sh: 0, lx: 0, ly: 0, lz: 0, lh: 0,
        homeX: 0, homeZ: 0, homeHeading: 0, aim: 0, size: 1, k: 1,
        // cower, watch, follow or home; the tick record (sim/score.js stepTo) and the tick this chapter turns on.
        state: 'cower', rec: { tick: 0, alpha: 1, at: 0 }, turnTick: 0,
        // Live on a player: { by, anchor, sendTick, near, ex, ez, eh }; the dice of a follower's detours (live or home).
        live: null, rand: null,
        // The probe's last answer, ticks left of a turn off a blocked line, the side it turns to, and how many ticks the line has been clear.
        blocked: false, detour: 0, side: 1, clear: Infinity,
        // The clip playing and the ticks it started and ends on, so a puppet taken mid-step joins the clip where it already is, and `cycle` the clip's own length, for the ear's footfall clock. `cue` counts steps.
        clip: 'cower', stepStart: 0, stepEnd: 0, cycle: 0, cue: 0, speed: 0,
        lod: LOD_TIERS, puppet: null,
      })
    }
    this.free = this.slots.slice()
    this.puppets = []
    this.freePuppets = []
    this.asset = null
    this.durations = null

    this.tiles = new Map()
    // Snowmen whose tile unloaded while they were away from home.
    this.loose = []
    this.frame = 0
    this.loaded = false
    this.overflow = 0
    this.starved = 0
    this.replayed = 0
    this.behind = 0

    // Her head, and the peers' heads this frame, as update() was given them.
    this.hx = 0; this.hy = 0; this.hz = 0
    this.peers = []
    // The room's latest anchor per key, and the anchors this client owes it.
    this.anchored = new Map()
    this.outbox = []

    if (asset) {
      this.setAsset(asset)
      this.ready = Promise.resolve(true)
    } else {
      this.ready = this.load()
    }
  }

  async load() {
    this.setAsset(await loadBipedGlb(CRITTER_GLB.snowman))
    return true
  }

  setAsset(asset) {
    this.asset = asset
    this.durations = Object.fromEntries(asset.clips.map((c) => [c.name, c.duration]))
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
    this.loaded = true
  }

  /**
   * The ground at (x, z) a snowman may stand on, or null: the walk surface,
   * dry, clear of a trunk, and no steeper than MAX_SLOPE when `placing` -- when
   * it must be above the snow line too -- or FOLLOW_SLOPE when a walker is
   * looking ahead. A walking snowman is held to neither the snow nor the
   * gentle ground it was laid on.
   */
  seat(x, z, placing = false) {
    const y = this.walk.heightAt(x, z)
    if (this.water.isSubmerged(x, z, y)) return null
    if (placing && y < this.height.snowLineAt(x, z)) return null
    if (this.walk.obstacleAt(x, z, _trunk)) return null
    this.walk.normalAt(x, z, undefined, _norm)
    if (Math.acos(Math.min(1, _norm.y)) > (placing ? MAX_SLOPE : FOLLOW_SLOPE)) return null
    return y
  }

  _enter(tx, tz, now) {
    const rand = mulberry32(tileSeed(tx, tz, this.seed))
    const t = { tx, tz, animals: [] }
    const want = DENSITY * TILE * TILE
    const n = Math.floor(want) + (rand() < want % 1 ? 1 : 0)
    for (let i = 0; i < n; i++) {
      // Everything is rolled before anything is skipped, so a tile lays the same snowmen whatever it did last time.
      const x = (tx + rand()) * TILE
      const z = (tz + rand()) * TILE
      const size = between(rand, SIZE_M)
      const heading = rand() * Math.PI * 2
      const key = `sn:${tx},${tz},${i}`
      // The snowman this tile let out when it last unloaded is still about: the tile takes it back where it stands.
      const held = this.loose.findIndex((l) => l.key === key)
      if (held >= 0) {
        const c = this.loose[held]
        this.loose.splice(held, 1)
        c.loose = false
        c.tile = t
        t.animals.push(c)
        continue
      }
      if (this.seat(x, z, true) === null) continue
      const c = this.free.pop()
      if (!c) { this.overflow++; continue }
      c.tile = t
      c.key = key
      c.hash = keyHash(key)
      c.loose = false
      c.homeX = x
      c.homeZ = z
      c.homeHeading = heading
      c.size = size
      c.k = size / this.asset.height
      c.lod = LOD_TIERS
      c.puppet = null
      this._replace(c, now)
      t.animals.push(c)
    }
    return t
  }

  /** A tile gone: every snowman on it let loose, so one still in sight is dissolved by the ladder rather than switched off with its tile. */
  _leave(t) {
    for (const c of t.animals) {
      c.tile = null
      c.loose = true
      this.loose.push(c)
    }
    t.animals.length = 0
  }

  _free(c) {
    this._releasePuppet(c)
    c.tile = null
    c.loose = false
    c.key = ''
    this.free.push(c)
  }

  /** Rebuild every tile around (cx, cz) at world time `now`. Boot, and whenever the ground moves under her. */
  place(cx, cz, now) {
    if (!Number.isFinite(now)) throw new Error(`Snowmen.place needs the world time, got ${now}`)
    for (const t of this.tiles.values()) this._leave(t)
    this.tiles.clear()
    for (const c of this.loose) this._free(c)
    this.loose.length = 0
    this.overflow = 0
    if (!this.loaded) return
    walkTiles(this.tiles, cx, cz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz, now), (t) => this._leave(t))
  }

  get stats() {
    const states = { cower: 0, watch: 0, follow: 0, home: 0 }
    for (const c of this.slots) if (c.tile || c.loose) states[c.state]++
    return { alive: MAX - this.free.length, states, loose: this.loose.length, puppets: this.puppets.length - this.freePuppets.length, tiles: this.tiles.size, overflow: this.overflow, starved: this.starved, replayed: this.replayed, behind: this.behind }
  }

  /**
   * Every snowman drawn this frame, for the ear (audio/ambience.js): the slots
   * themselves, with x, y, z, size, clip, cycle and speed on them, `speed > 0`
   * meaning it is walking or running. A hidden layer is frozen and lists
   * nothing; nor does one past its last rung.
   */
  bodies(into) {
    if (!this.batch.visible) return into
    for (const c of this.slots) if ((c.tile !== null || c.loose) && c.lod < LOD_TIERS) into.push(c)
    return into
  }

  // -------------------------------------------------------------------------
  // Placing: at home, or where the room's anchor has it.
  // -------------------------------------------------------------------------

  /** The body put at a pose, standing, the tick before it the same, its ground read. */
  _place(c, x, z, heading) {
    c.sx = c.lx = c.x = x
    c.sz = c.lz = c.z = z
    c.sh = c.lh = c.heading = c.aim = heading
    c.sy = c.ly = c.y = this.walk.heightAt(x, z)
  }

  /** The snowman placed afresh at `now`: where the room's anchor has it when there is one from this chapter, else at home. Birth, and a body too long unstepped to replay (a clock skip): its player forgotten. */
  _replace(c, now) {
    c.live = null
    c.rand = null
    const k = tickOf(now)
    c.rec.at = k
    c.turnTick = tickAfter(chapterOf(now, c.key).start + CHAPTER_S)
    const anchor = this.anchored.get(c.key)
    if (anchor && anchor[1] >= chapterOf(now, c.key).start) {
      this._fromAnchor(c, anchor, now)
    } else {
      this._place(c, c.homeX, c.homeZ, c.homeHeading)
      c.rec.tick = k
      this._cower(c, k)
    }
  }

  /** The snowman put where the room's anchor has it at the anchor's time, the ticks since replayed: live on its player while the anchor is fresh; else walking home (a live anchor gone stale, from ANCHOR_STALE_S after it, when every client gave the player up). */
  _fromAnchor(c, anchor, now) {
    const [, T, x, , z, heading, , mode, by, near] = anchor
    this._place(c, x, z, heading)
    if (mode !== 'watch' && mode !== 'follow' && mode !== 'rejoin') throw new Error(`Snowmen: no anchor mode ${mode}`)
    if (mode !== 'rejoin' && now - T < ANCHOR_STALE_S) {
      c.rec.tick = tickOf(T)
      this._golive(c, mode, by, c.rec.tick, near)
      c.live.anchor = anchor
      return
    }
    const from = mode === 'rejoin' ? tickOf(T) : tickOf(T + ANCHOR_STALE_S)
    c.rec.tick = Math.min(from, tickOf(now))
    this._goHome(c, from)
  }

  /**
   * An anchor heard from the room, `[key, T, x, y, z, heading, -1, mode, by,
   * near]`, `by` the client it came from (null for this client's own, which is
   * ignored). Kept for a snowman not yet laid; on one that is, a live anchor
   * puts a snowman not yet live where the anchor has it, live on that client's
   * player, and nudges one already live; a follow anchor sets a watcher after
   * them; a rejoin anchor sets it walking home from the anchor's pose and
   * time. One this client is the authority for (two players stepped in front
   * of it in the same instant) keeps its own player.
   */
  apply(anchor, now) {
    const [key, T, , , , , , mode, by, near] = anchor
    if (!Number.isFinite(T)) throw new Error(`Snowmen: an anchor with no time: ${JSON.stringify(anchor)}`)
    if (by === null) return
    if (mode !== 'watch' && mode !== 'follow' && mode !== 'rejoin') throw new Error(`Snowmen: no anchor mode ${mode}`)
    if (mode !== 'rejoin' && !Number.isFinite(near)) throw new Error(`Snowmen: a live anchor with no nearest: ${JSON.stringify(anchor)}`)
    this.anchored.set(key, anchor)
    const c = this.slots.find((s) => s.key === key && (s.tile !== null || s.loose))
    if (!c || (c.live && c.live.by === null)) return
    // From a chapter gone: the snowman has been home since its turn.
    if (T < chapterOf(now, key).start) return
    if (!c.live || mode === 'rejoin') {
      c.live = null
      this._fromAnchor(c, anchor, now)
      return
    }
    const live = c.live
    live.anchor = anchor
    live.by = by
    // The error against the anchor, taken now, worn off over CORRECT_S: the anchor's pose itself is a relay's latency old, a running snowman metres past it already.
    live.ex = anchor[2] - c.sx
    live.ez = anchor[4] - c.sz
    live.eh = swing(c.sh, anchor[5])
    if (mode === 'follow' && c.state === 'watch') this._follow(c, tickOf(now))
  }

  /** The anchors this client owes the room since the last call, moved into `into`. */
  pending(into = []) {
    for (const a of this.outbox) into.push(a)
    this.outbox.length = 0
    return into
  }

  /** This snowman's anchor at tick `k`, owed to the room, and kept as the room's latest for it, so that put to sleep and woken again it resumes as its peers have it. */
  _owe(c, k, mode) {
    const anchor = [c.key, k * TICK_S, c.sx, c.sy, c.sz, c.sh, -1, mode, null, c.live ? c.live.near : 0]
    this.outbox.push(anchor)
    this.anchored.set(c.key, anchor)
  }

  // -------------------------------------------------------------------------
  // What a snowman is doing.
  // -------------------------------------------------------------------------

  /** The player this snowman is live on: her for `by` null, else the peer under that id; null once they are gone from the room. */
  _player(by) {
    if (by === null) { _her.x = this.hx; _her.y = this.hy; _her.z = this.hz; return _her }
    for (const p of this.peers) if (p.by === by) return p
    return null
  }

  /** A player's distance from the body's tick pose, and the heading that faces them. */
  _dist(c, p) { return Math.sqrt((p.x - c.sx) ** 2 + (p.y - c.sy) ** 2 + (p.z - c.sz) ** 2) }
  _toward(c, x, z) { return Math.atan2(-(z - c.sz), x - c.sx) }

  /** Cowering where it stands, facing wherever it faces, from tick `k`. */
  _cower(c, k) {
    c.state = 'cower'
    c.live = null
    c.rand = null
    this._clearDetour(c)
    this._gesture(c, COWER_ACTS, k)
  }

  /** Live on `by`'s player from tick `k` in `mode`, `near` the closest they have come. `by` null is her, which makes this client the authority, owing the room its anchors from this tick; a peer's is nudged by the error `ex, ez, eh` its anchors find. */
  _golive(c, mode, by, k, near) {
    c.live = { by, anchor: null, sendTick: k + ticksOf(ANCHOR_S), near, ex: 0, ez: 0, eh: 0 }
    c.rand = mulberry32(hash32(c.hash, k, 2))
    this._clearDetour(c)
    if (mode === 'follow') this._follow(c, k)
    else this._watch(c, k)
    if (by === null) this._owe(c, k, mode)
  }

  /** Turned to its player, and gesturing, from tick `k`. */
  _watch(c, k) {
    c.state = 'watch'
    this._clearDetour(c)
    this._gesture(c, WATCH_ACTS, k)
  }

  /** After its player from tick `k`, at once. */
  _follow(c, k) {
    c.state = 'follow'
    this._clearDetour(c)
    const p = this._player(c.live.by)
    this._play(c, p !== null && this._dist(c, p) > RUN_M ? 'run' : 'walk', k, Infinity)
  }

  /** The player forgotten at tick `k`: a rejoin anchor owed if this client was the authority, and the walk home begun. */
  _unlive(c, k) {
    const mine = c.live.by === null
    if (mine) this._owe(c, k, 'rejoin')
    c.live = null
    this._goHome(c, k)
  }

  /** Walking home from tick `k`, its detours rolled from that tick; at home already, cowering. */
  _goHome(c, k) {
    if (Math.hypot(c.homeX - c.sx, c.homeZ - c.sz) <= HOME_M) { this._cower(c, k); return }
    c.state = 'home'
    c.rand = mulberry32(hash32(c.hash, k, 3))
    this._clearDetour(c)
    c.aim = this._toward(c, c.homeX, c.homeZ)
    this._play(c, 'walk', k, Infinity)
  }

  /**
   * The gesture a standing snowman is on at tick `k`, closed-form in (key,
   * k): its GRID_S segment's chain from `table`, rolled from the segment's own
   * dice and walked to k, the segment's last gesture cut at its end. Into
   * `_gesture` as { clip, start, end } in ticks.
   */
  _gestureAt(c, table, k) {
    const phase = c.hash % GRID_TICKS
    const seg = Math.floor((k + phase) / GRID_TICKS)
    const rand = mulberry32(hash32(c.hash, seg, TABLE_ID.get(table)))
    const d = this.durations
    let start = seg * GRID_TICKS - phase
    const end = start + GRID_TICKS
    for (;;) {
      const act = weighted(rand, table)
      const s = act === 'idle' ? between(rand, STARE_S) : table === COWER_ACTS ? Math.round(between(rand, COWER_CYCLES)) * d[act] : d[act]
      const stop = Math.min(end, start + ticksOf(s))
      if (stop > k) { _gesture.clip = act; _gesture.start = start; _gesture.end = stop; return _gesture }
      start = stop
    }
  }

  /** The gesture at tick `k` from `table`, played from where it already is. */
  _gesture(c, table, k) {
    const g = this._gestureAt(c, table, k)
    this._play(c, g.clip, g.start, g.end)
  }

  /** `clip` from tick `start` to tick `end`, as a new step. */
  _play(c, clip, start, end) {
    c.clip = clip
    c.stepStart = start
    c.stepEnd = end
    c.cycle = this.durations[clip]
    c.cue++
    const speed = this.asset.gait[clip]
    c.speed = speed === undefined ? 0 : speed * c.k
  }

  /**
   * Ease the heading toward the aim, TURN_RATE at the most, and report how much
   * of a step that leaves: the cosine of the swing it still owes, so a body
   * turned three-quarters round makes no ground at all and pivots instead.
   */
  _turn(c) {
    const s = swing(c.sh, c.aim)
    c.sh += Math.sign(s) * Math.min(Math.abs(s), TURN_RATE * TICK_S)
    return Math.max(0, Math.cos(s))
  }

  _clearDetour(c) {
    c.blocked = false
    c.detour = 0
    c.clear = Infinity
  }

  /**
   * One tick of a walking snowman toward its mark (x, z): every PROBE_EVERY
   * ticks a look ahead. No seat there and it pivots on the spot, always to the
   * same side while it is skirting the one thing, until the line is clear,
   * then holds that line for DETOUR_S; otherwise, and once a detour is over,
   * it aims at its mark. Then the turn, then a step along the heading, and
   * the ground under it.
   */
  _walk(c, x, z, k) {
    if (c.detour > 0) c.detour--
    if ((k + c.hash) % PROBE_EVERY === 0) {
      const ahead = c.size * AHEAD
      c.blocked = this.seat(c.sx + Math.cos(c.sh) * ahead, c.sz - Math.sin(c.sh) * ahead) === null
      if (c.blocked) {
        if (c.clear > SIDE_S * TICK_HZ) c.side = c.rand() < 0.5 ? 1 : -1
        c.clear = 0
        c.detour = ticksOf(DETOUR_S)
        c.aim = c.sh + c.side * (Math.PI / 3 + c.rand() * Math.PI / 6)
      }
    }
    if (!c.blocked) c.clear++
    if (c.detour <= 0) c.aim = this._toward(c, x, z)
    const d = c.blocked ? 0 : c.speed * TICK_S * this._turn(c)
    if (c.blocked) this._turn(c)
    if (d > 0) {
      c.sx += Math.cos(c.sh) * d
      c.sz -= Math.sin(c.sh) * d
      c.sy = this.walk.heightAt(c.sx, c.sz)
    }
  }

  /**
   * One tick live, at tick `k`: the player lost -- gone from the room, past
   * FORGET_M, or (a peer's) no anchor for ANCHOR_STALE_S -- and it forgets
   * them; else the state machine against their distance: follow, stop, start
   * again; a watcher and a stopped follower gesture and aim at them, a walker
   * walks after them. A peer's snowman wears off the error its last anchor
   * found over CORRECT_S; the authority's anchor is owed every ANCHOR_S.
   */
  _stepLive(c, k) {
    const live = c.live
    const p = this._player(live.by)
    const fresh = live.by === null || (live.anchor !== null && k * TICK_S - live.anchor[1] < ANCHOR_STALE_S)
    if (p === null || !fresh || this._dist(c, p) > FORGET_M) { this._unlive(c, k); return }
    const dist = this._dist(c, p)
    if (c.state === 'watch') {
      live.near = Math.min(live.near, dist)
      if (dist > live.near + AWAY_M) this._follow(c, k)
    }
    if (c.state === 'follow') {
      const moving = c.speed > 0
      if (moving && dist <= STANDOFF_M) {
        this._clearDetour(c)
        this._gesture(c, WATCH_ACTS, k)
      } else if (!moving && dist > STANDOFF_M + RESUME_M) {
        this._play(c, dist > RUN_M ? 'run' : 'walk', k, Infinity)
      } else if (moving && c.clip === 'walk' && dist > RUN_M + 1) {
        this._play(c, 'run', k, Infinity)
      } else if (moving && c.clip === 'run' && dist < RUN_M - 1) {
        this._play(c, 'walk', k, Infinity)
      }
    }
    if (c.speed > 0) {
      this._walk(c, p.x, p.z, k)
    } else {
      if (k >= c.stepEnd) this._gesture(c, WATCH_ACTS, k)
      c.aim = this._toward(c, p.x, p.z)
      this._turn(c)
    }
    if (live.by !== null) {
      const f = TICK_S / CORRECT_S
      c.sx += live.ex * f; live.ex -= live.ex * f
      c.sz += live.ez * f; live.ez -= live.ez * f
      c.sh += live.eh * f; live.eh -= live.eh * f
    }
    if (live.by === null && k >= live.sendTick) {
      this._owe(c, k, c.state)
      live.sendTick = k + ticksOf(ANCHOR_S)
    }
  }

  /** One tick at absolute tick `k`: the tick before kept for the frame to draw from; live, the follow rule; else the walk home, the chapter's turn, the cower's gesture, and her noticed inside NOTICE_M on the side it faces. */
  _step(c, k) {
    c.lx = c.sx; c.ly = c.sy; c.lz = c.sz; c.lh = c.sh
    if (k >= c.turnTick) {
      // At the chapter turn every snowman not live is home: one still walking there is put there. A live one goes on, its rejoin anchor the pose the room walks it home from.
      c.turnTick += CHAPTER_S * TICK_HZ
      if (c.state === 'home') { this._place(c, c.homeX, c.homeZ, c.homeHeading); this._cower(c, k) }
    }
    if (c.live) { this._stepLive(c, k); return }
    if (c.state === 'home') {
      this._walk(c, c.homeX, c.homeZ, k)
      if (Math.hypot(c.homeX - c.sx, c.homeZ - c.sz) <= HOME_M) this._cower(c, k)
    } else if (k >= c.stepEnd) {
      this._gesture(c, COWER_ACTS, k)
    }
    const dx = this.hx - c.sx, dy = this.hy - c.sy, dz = this.hz - c.sz
    if (dx * dx + dy * dy + dz * dz < NOTICE_M * NOTICE_M && Math.abs(swing(c.sh, this._toward(c, this.hx, this.hz))) < Math.PI / 2) {
      this._golive(c, 'watch', null, k, Math.sqrt(dx * dx + dy * dy + dz * dz))
    }
  }

  /** The pose the frame draws: between the last two ticks by rec.alpha, the heading round the shorter way. */
  _pose(c) {
    const a = c.rec.alpha
    c.x = lerp(c.lx, c.sx, a)
    c.y = lerp(c.ly, c.sy, a)
    c.z = lerp(c.lz, c.sz, a)
    c.heading = c.lh + swing(c.lh, c.sh) * a
  }

  _takePuppet(c) {
    if (!c.puppet) {
      const p = this.freePuppets.pop()
      if (!p) { this.starved++; return null }
      c.puppet = p
      this.batch.add(p.group)
      // Joined where the step already is.
      p.play(c.clip, c.cue, (c.rec.tick - c.stepStart) * TICK_S)
    }
    return c.puppet
  }

  /** Hand the puppet back at once, without a fade: for a snowman that has ceased to exist, not walked off. */
  _releasePuppet(c) {
    const p = c.puppet
    if (!p) return
    p.release()
    this.batch.remove(p.group)
    this.freePuppets.push(p)
    c.puppet = null
  }

  /**
   * One frame at world time `now`: every snowman stepped to it, and given a
   * puppet. (hx, hy, hz) is her head; `peers` the other players' heads, each
   * `{ x, y, z, by }` with `by` that client's id, read only while a snowman is
   * live on one. `dt` is the frame's seconds, for the puppets' fades.
   */
  update(hx, hy, hz, now, peers, dt) {
    if (!this.loaded) return
    if (!Number.isFinite(now)) throw new Error(`Snowmen.update needs the world time, got ${now}`)
    this.hx = hx; this.hy = hy; this.hz = hz
    this.peers = peers
    walkTiles(this.tiles, hx, hz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz, now), (t) => this._leave(t))
    this.frame++
    this.replayed = 0
    this.behind = 0

    for (const t of this.tiles.values()) for (const c of t.animals) this._tick(c, now, dt, false)
    for (let i = this.loose.length - 1; i >= 0; i--) {
      const c = this.loose[i]
      if (this._tick(c, now, dt, true)) {
        this.loose.splice(i, 1)
        this._free(c)
      }
    }
  }

  /** One snowman's frame; true once a loose one has dissolved out past the tile horizon and can be freed. */
  _tick(c, now, dt, loose) {
    const want = tickOf(now)
    // The clock moved further since its last frame than a frame can replay (a skip): the gap is not replayed, the snowman is placed afresh, as if she had stepped out of the timeline and back in. A join's replay lags `rec.tick` as far, over frames, and is not a skip.
    if (want - c.rec.at > CATCH_UP_TICKS) this._replace(c, now)
    c.rec.at = want
    this.replayed += stepTo(c.rec, now, (k) => this._step(c, k))
    // Still replaying: not drawn until it is here.
    if (c.rec.tick < want) { this.behind++; return false }
    this._pose(c)

    const dx = c.x - this.hx
    const dz = c.z - this.hz
    const dy = c.y - this.hy
    c.lod = critterTier(c.size, Math.sqrt(dx * dx + dy * dy + dz * dz), c.lod, LOD_TIERS)
    // A loose snowman is freed only out past where any tile is loaded, so the tile that re-enters lays it again; the ladder has long since dissolved it out there.
    const beyond = loose && Math.hypot(dx, dz) > RADIUS + TILE
    const show = c.lod === LOD_TIERS || beyond ? -1 : c.lod
    const puppet = show === -1 && !c.puppet ? null : this._takePuppet(c)
    if (!puppet) return beyond
    puppet.show(show)
    _pos.set(c.x, c.y, c.z)
    // The body faces +X, yawed about the world up to its heading. It stands on
    // that up, never on the ground's normal: a biped on a hillside is vertical.
    _quat.setFromAxisAngle(UP, c.heading)
    _scl.setScalar(c.k)
    _mat.compose(_pos, _quat, _scl)

    puppet.play(c.clip, c.cue)
    groundFeet(puppet, c, this.walk, PLANTED, (this.frame + c.id) % REPLANT_EVERY === 0)
    puppet.step(dt)
    puppet.group.matrix.copy(_mat)
    puppet.group.matrixWorldNeedsUpdate = true
    if (puppet.done) {
      this._releasePuppet(c)
      return beyond
    }
    return false
  }

  dispose() {
    this.batch.parent?.remove(this.batch)
    for (const m of this.materials) m.dispose()
    this.asset?.map?.dispose()
    for (const geo of this.asset?.tiers ?? []) geo.dispose()
  }
}
