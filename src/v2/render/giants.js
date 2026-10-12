// The green giants (design/41-palisade-labyrinths.md): one per labyrinth, a green yeti a metre over its posts. Its round
// is closed-form in the room's clock along the maze's graph; noticing her makes this client its authority, owing anchors,
// as the snowmen's (render/snowmen.js). Round, chase, swing, forget, back.

import THREE from '../../three-instance.js'
import { lazyLoad } from '../lazy-load.js'
import { lerp, mulberry32 } from '../../sim/mathx.js'
import { CATCH_UP_TICKS, CHAPTER_S, TICK_HZ, TICK_S, chapterOf, hash32, keyHash, stepTo, swing, tickAfter, tickOf } from '../../sim/score.js'
import { CRITTER_GLB, critterTier } from './critters.js'
import { groundFeet, loadSkinnedAsset, makePuppetMaterials, makeSettledMaterial } from './puppet.js'
import { makePuppet } from './baked-puppet.js'
import { LOD_TIERS } from './snowmen.js'
import { POST_HEIGHT } from '../layers/labyrinths.js'

export const HEIGHT_M = POST_HEIGHT + 1
// A linear multiplier on the yeti's white fur.
export const TINT = [0.42, 0.8, 0.32]
// Giants are laid for the labyrinths within this of her; a region holds one, so few are ever laid.
export const LAY_M = 160
export const MAX = 4
// Ground speeds: on its round, and after her or back to its round -- under her 1.45 walk (player.js LOCOMOTION.maxSpeed).
export const ROUND_SPEED = 0.6
export const CHASE_SPEED = 1.0
export const NOTICE_M = 10
export const FORGET_M = 20
export const ABOVE_M = 4
// It swings within REACH_M; the blow lands BLOW_AT through the swing if she is still within REACH_M + SLACK_M.
export const REACH_M = 2.2
const SLACK_M = 0.5
export const BLOW = 25
const BLOW_AT = 0.5
// The threaten clip's rate, as a swing.
const SWING_RATE = 0.6
// Seconds it stands in each dead end of its round, and in the middle at the round's turn.
const PAUSE_S = [2, 5]
const MIDDLE_S = 8
export const TURN_RATE = 1.0
// Within this of a waypoint it is through it.
const ARRIVE_M = 0.4
export const ANCHOR_S = 1
export const ANCHOR_STALE_S = 3
const CORRECT_S = 1
const REPLANT_EVERY = 6
const FADE_S = 0.25
export const CLIPS = ['idle', 'walk', 'threaten']
const PLANTED = new Set(['idle'])
const MODES = new Set(['chase', 'swing', 'rejoin'])

const ticksOf = (s) => Math.max(1, Math.round(s * TICK_HZ))
const UP = new THREE.Vector3(0, 1, 0)
const _quat = new THREE.Quaternion()
const _pos = new THREE.Vector3()
const _scl = new THREE.Vector3()
const _mat = new THREE.Matrix4()
const _at = { x: 0, z: 0, moving: false }
const _her = { x: 0, y: 0, z: 0, by: null }
const _sites = []
const _path = []

function shuffled(list, rand) {
  const out = list.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** Maze `m`'s round for the giant hashed `hash`: its points `xs`, `zs` and the seconds `ts` each is reached, from the middle and back to it, `length` seconds long. */
export function roundOf(m, hash) {
  const total = m.cells.length, rand = mulberry32(hash32(hash, 0, 5))
  const at = (id) => (id === total ? m.middle : m.cells[id])
  const xs = [], zs = [], ts = []
  let t = 0
  const put = (x, z, pause) => {
    if (xs.length > 0) t += Math.hypot(x - xs[xs.length - 1], z - zs[zs.length - 1]) / ROUND_SPEED
    xs.push(x); zs.push(z); ts.push(t)
    if (pause > 0) { t += pause; xs.push(x); zs.push(z); ts.push(t) }
  }
  const seen = new Uint8Array(total + 1)
  seen[total] = 1
  put(m.middle[0], m.middle[1], 0)
  const stack = [{ id: total, ways: shuffled(m.ways[total], rand), i: 0, via: null }]
  while (stack.length > 0) {
    const f = stack[stack.length - 1]
    if (f.i < f.ways.length) {
      const w = f.ways[f.i++]
      if (seen[w.to]) continue
      seen[w.to] = 1
      put(w.x, w.z, 0)
      put(...at(w.to), m.ways[w.to].length === 1 ? PAUSE_S[0] + rand() * (PAUSE_S[1] - PAUSE_S[0]) : 0)
      stack.push({ id: w.to, ways: shuffled(m.ways[w.to], rand), i: 0, via: w })
    } else {
      stack.pop()
      if (f.via === null) continue
      const back = stack[stack.length - 1].id
      put(f.via.x, f.via.z, 0)
      put(...at(back), back === total ? MIDDLE_S : 0)
    }
  }
  return { xs, zs, ts, length: t, offset: ((hash % 100003) / 100003) * t }
}

/** Where `round` has the giant at world time `seconds`, into `out` { x, z, moving }. */
export function roundAt(round, seconds, out) {
  const { xs, zs, ts, length } = round
  const tau = (((seconds + round.offset) % length) + length) % length
  let lo = 0, hi = ts.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (ts[mid] <= tau) lo = mid
    else hi = mid
  }
  const f = ts[hi] > ts[lo] ? (tau - ts[lo]) / (ts[hi] - ts[lo]) : 0
  out.x = lerp(xs[lo], xs[hi], f)
  out.z = lerp(zs[lo], zs[hi], f)
  out.moving = xs[lo] !== xs[hi] || zs[lo] !== zs[hi]
  return out
}

export class Giants {
  /**
   * @param labyrinths  layers/labyrinths.js Labyrinths: sitesIn, mazeOf, nodeAt
   * @param opts.walk   heightAt: the bare ground (V2Height), not the WalkSurface, whose posts would stand a giant brushing a wall on top of it
   * @param opts.asset  a loaded asset, for a gate; the world fetches the GLB
   */
  constructor(scene, labyrinths, { walk, asset = null } = {}) {
    if (typeof labyrinths?.nodeAt !== 'function') throw new Error('Giants needs the Labyrinths, for nodeAt')
    if (typeof walk?.heightAt !== 'function') throw new Error('Giants needs the ground, for heightAt')
    this.labyrinths = labyrinths
    this.walk = walk
    this.batch = new THREE.Group()
    this.batch.name = 'v2-giants'
    scene.add(this.batch)
    this.plain = makeSettledMaterial('giants')
    this.plain.color.setRGB(...TINT)
    this.materials = [this.plain]
    this.puppetMats = []
    for (let i = 0; i < MAX; i++) {
      const mats = makePuppetMaterials('giants', this.plain)
      for (const m of [mats.in, mats.out]) m.color.setRGB(...TINT)
      this.puppetMats.push(mats)
      this.materials.push(mats.in, mats.out)
    }
    this.slots = []
    for (let i = 0; i < MAX; i++) {
      this.slots.push({
        id: i, key: '', hash: 0, site: null, m: null, round: null, laid: false,
        x: 0, y: 0, z: 0, heading: 0, sx: 0, sy: 0, sz: 0, sh: 0, lx: 0, ly: 0, lz: 0, lh: 0, aim: 0,
        size: HEIGHT_M, k: 1,
        // round, back, chase or swing; the tick record (sim/score.js stepTo) and the tick this chapter turns on.
        state: 'round', rec: { tick: 0, alpha: 1, at: 0 }, turnTick: 0,
        // Live on a player: { by, anchor, sendTick, ex, ez, eh }.
        live: null, blowTick: -1,
        // The clip, the ticks it runs between, its rate, `cycle` its length at that rate (the ear's footfall clock), `cue` counting plays, and the ground speed.
        clip: 'idle', stepStart: 0, stepEnd: 0, rate: 1, cycle: 1, cue: 0, speed: 0,
        lod: LOD_TIERS, puppet: null,
      })
    }
    this.puppets = []
    this.freePuppets = []
    this.rounds = new Map()
    this.asset = null
    this.durations = null
    this.loaded = false
    this.frame = 0
    this.hx = 0; this.hy = 0; this.hz = 0
    this.peers = []
    this.anchored = new Map()
    this.outbox = []
    // HP of the blows landed on her since the last drain.
    this.owed = 0
    this._parent = new Int32Array(0)
    this._queue = []
    if (asset) {
      this.setAsset(asset)
      this.ready = Promise.resolve(true)
    } else {
      this.lazy = lazyLoad(() => this.load())
      this.ready = this.lazy.ready
    }
  }

  async load() {
    const asset = await loadSkinnedAsset(CRITTER_GLB.snowman, { tiers: LOD_TIERS, clips: CLIPS, extras: 'biped' })
    if (!(asset.extras.height > 0) || !(asset.extras.gait?.walk > 0)) throw new Error(`${CRITTER_GLB.snowman}: no height or walk speed in its extras -- re-ship it`)
    this.setAsset({ ...asset, ...asset.extras })
    return true
  }

  setAsset(asset) {
    this.asset = asset
    this.durations = Object.fromEntries(asset.clips.map((c) => [c.name, c.duration]))
    for (const name of CLIPS) if (!(this.durations[name] > 0)) throw new Error(`Giants: the asset carries no ${name} clip`)
    this.plain.map = asset.map
    this.plain.needsUpdate = true
    for (const mats of this.puppetMats) {
      for (const m of [mats.in, mats.out]) { m.map = asset.map; m.needsUpdate = true }
      this.puppets.push(makePuppet(asset, mats, { clipFade: FADE_S }))
    }
    this.freePuppets = this.puppets.slice()
    this.loaded = true
  }

  /** HP of the blows that have landed on her since the last call. */
  drainBlows() {
    const n = this.owed
    this.owed = 0
    return n
  }

  /** Every giant drawn this frame, for the ear (audio/ambience.js): x, y, z, size, clip, cycle and speed on each. */
  bodies(into) {
    if (!this.batch.visible) return into
    for (const c of this.slots) if (c.laid && c.lod < LOD_TIERS) into.push(c)
    return into
  }

  get stats() {
    const states = { round: 0, back: 0, chase: 0, swing: 0 }
    for (const c of this.slots) if (c.laid) states[c.state]++
    return { laid: this.slots.filter((c) => c.laid).length, states }
  }

  // -------------------------------------------------------------------------
  // The room: anchors as the snowmen's, `[key, T, x, y, z, heading, -1, mode, by, 0]`.
  // -------------------------------------------------------------------------

  /** An anchor heard from the room (`by` null, this client's own, is ignored): kept for a giant not yet laid; on one laid, puts it live on that client's player where the anchor has it, nudges one already live, or (rejoin) sets it walking back from there. One this client is the authority for keeps its own player. */
  apply(anchor, now) {
    const [key, T, , , , , , mode, by] = anchor
    if (!Number.isFinite(T)) throw new Error(`Giants: an anchor with no time: ${JSON.stringify(anchor)}`)
    if (by === null) return
    if (!MODES.has(mode)) throw new Error(`Giants: no anchor mode ${mode}`)
    this.anchored.set(key, anchor)
    const c = this.slots.find((s) => s.laid && s.key === key)
    if (!c || (c.live && c.live.by === null)) return
    if (T < chapterOf(now, key).start) return
    if (!c.live || mode === 'rejoin') {
      c.live = null
      this._fromAnchor(c, anchor, now)
      return
    }
    c.live.anchor = anchor
    c.live.by = by
    c.live.ex = anchor[2] - c.sx
    c.live.ez = anchor[4] - c.sz
    c.live.eh = swing(c.sh, anchor[5])
  }

  pending(into = []) {
    for (const a of this.outbox) into.push(a)
    this.outbox.length = 0
    return into
  }

  _owe(c, k, mode) {
    const anchor = [c.key, k * TICK_S, c.sx, c.sy, c.sz, c.sh, -1, mode, null, 0]
    this.outbox.push(anchor)
    this.anchored.set(c.key, anchor)
  }

  // -------------------------------------------------------------------------
  // Laying and placing.
  // -------------------------------------------------------------------------

  _lay(c, s, now) {
    c.key = `gg:${s.rx},${s.rz}`
    c.hash = keyHash(c.key)
    c.site = s
    c.m = this.labyrinths.mazeOf(s)
    let round = this.rounds.get(c.key)
    if (round === undefined) this.rounds.set(c.key, (round = roundOf(c.m, c.hash)))
    c.round = round
    c.k = HEIGHT_M / this.asset.height
    c.lod = LOD_TIERS
    c.laid = true
    this._replace(c, now)
  }

  _unlay(c) {
    const p = c.puppet
    if (p) {
      p.release()
      this.batch.remove(p.group)
      this.freePuppets.push(p)
      c.puppet = null
    }
    c.laid = false
    c.live = null
    c.key = ''
  }

  _place(c, x, z, heading) {
    c.sx = c.lx = c.x = x
    c.sz = c.lz = c.z = z
    c.sh = c.lh = c.heading = c.aim = heading
    c.sy = c.ly = c.y = this.walk.heightAt(x, z)
  }

  /** Placed afresh at `now`: where this chapter's anchor has it, else on its round. */
  _replace(c, now) {
    c.live = null
    const k = tickOf(now)
    c.rec.at = k
    c.turnTick = tickAfter(chapterOf(now, c.key).start + CHAPTER_S)
    const anchor = this.anchored.get(c.key)
    if (anchor && anchor[1] >= chapterOf(now, c.key).start) {
      this._fromAnchor(c, anchor, now)
    } else {
      c.rec.tick = k
      this._toRound(c, k)
    }
  }

  /** Put on its round at tick `k`, facing the way the round goes. */
  _toRound(c, k) {
    const ahead = roundAt(c.round, (k + TICK_HZ) * TICK_S, _at)
    const ax = ahead.x, az = ahead.z
    roundAt(c.round, k * TICK_S, _at)
    this._place(c, _at.x, _at.z, ax === _at.x && az === _at.z ? c.sh : Math.atan2(-(az - _at.z), ax - _at.x))
    c.state = 'round'
    c.live = null
    this._play(c, _at.moving ? 'walk' : 'idle', k, ROUND_SPEED)
  }

  _fromAnchor(c, anchor, now) {
    const [, T, x, , z, heading, , mode, by] = anchor
    if (!MODES.has(mode)) throw new Error(`Giants: no anchor mode ${mode}`)
    this._place(c, x, z, heading)
    if (mode !== 'rejoin' && now - T < ANCHOR_STALE_S) {
      c.rec.tick = tickOf(T)
      this._golive(c, by, c.rec.tick)
      c.live.anchor = anchor
      return
    }
    const from = mode === 'rejoin' ? tickOf(T) : tickOf(T + ANCHOR_STALE_S)
    c.rec.tick = Math.min(from, tickOf(now))
    this._goBack(c, from)
  }

  // -------------------------------------------------------------------------
  // What a giant is doing.
  // -------------------------------------------------------------------------

  /** `clip` from tick `start`, its ground speed `speed` (0 standing), a walk's rate matched to it. */
  _play(c, clip, start, speed, end = Infinity) {
    c.clip = clip
    c.stepStart = start
    c.stepEnd = end
    c.speed = clip === 'walk' ? speed : 0
    c.rate = clip === 'walk' ? speed / (this.asset.gait.walk * c.k) : clip === 'threaten' ? SWING_RATE : 1
    c.cycle = this.durations[clip] / c.rate
    c.cue++
  }

  _player(by) {
    if (by === null) { _her.x = this.hx; _her.y = this.hy; _her.z = this.hz; return _her }
    for (const p of this.peers) if (p.by === by) return p
    return null
  }

  _golive(c, by, k) {
    c.live = { by, anchor: null, sendTick: k + ticksOf(ANCHOR_S), ex: 0, ez: 0, eh: 0 }
    c.state = 'chase'
    this._play(c, 'walk', k, CHASE_SPEED)
    if (by === null) this._owe(c, k, 'chase')
  }

  _unlive(c, k) {
    if (c.live.by === null) this._owe(c, k, 'rejoin')
    c.live = null
    this._goBack(c, k)
  }

  _goBack(c, k) {
    c.state = 'back'
    this._play(c, 'walk', k, CHASE_SPEED)
  }

  _turn(c) {
    const s = swing(c.sh, c.aim)
    c.sh += Math.sign(s) * Math.min(Math.abs(s), TURN_RATE * TICK_S)
    return Math.max(0, Math.cos(s))
  }

  /** The nodes from `from` to `to` along the graph, `from` first, into `path`. */
  _path(m, from, to, path) {
    const n = m.cells.length + 1
    if (this._parent.length < n) this._parent = new Int32Array(n)
    const parent = this._parent.fill(-1, 0, n), queue = this._queue
    queue.length = 0
    queue.push(from)
    parent[from] = from
    for (let q = 0; q < queue.length && parent[to] < 0; q++) for (const w of m.ways[queue[q]]) if (parent[w.to] < 0) { parent[w.to] = queue[q]; queue.push(w.to) }
    if (parent[to] < 0) throw new Error(`Giants: no way from node ${from} to ${to} in ${JSON.stringify([m.site.rx, m.site.rz])}`)
    path.length = 0
    for (let id = to; id !== from; id = parent[id]) path.push(id)
    path.push(from)
    return path.reverse()
  }

  /** One tick toward (tx, tz) at `speed` along the graph: through the next opening on the way to the node holding it; one outside is gone after to the entrance's cell. Stands once there. */
  _go(c, tx, tz, speed, k) {
    const L = this.labyrinths, m = c.m
    const inside = m.offs[m.offs.length - 2] + m.entrance
    let goal = L.nodeAt(c.site, tx, tz)
    if (goal === -1) { goal = inside; [tx, tz] = m.cells[inside] }
    const node = L.nodeAt(c.site, c.sx, c.sz)
    let ax = tx, az = tz
    if (node === -1) {
      [ax, az] = m.cells[inside]
    } else if (node !== goal) {
      const path = this._path(m, node, goal, _path)
      const w = m.ways[node].find((v) => v.to === path[1])
      ax = w.x; az = w.z
      if (Math.hypot(ax - c.sx, az - c.sz) < ARRIVE_M) {
        if (path.length > 2) { const v = m.ways[path[1]].find((u) => u.to === path[2]); ax = v.x; az = v.z } else { ax = tx; az = tz }
      }
    }
    const d = Math.hypot(ax - c.sx, az - c.sz)
    if (d < 0.05) {
      if (c.clip !== 'idle') this._play(c, 'idle', k, 0)
      return
    }
    if (c.clip !== 'walk' || c.speed !== speed) this._play(c, 'walk', k, speed)
    c.aim = Math.atan2(-(az - c.sz), ax - c.sx)
    const step = Math.min(d, speed * TICK_S * this._turn(c))
    c.sx += Math.cos(c.sh) * step
    c.sz -= Math.sin(c.sh) * step
    c.sy = this.walk.heightAt(c.sx, c.sz)
  }

  /** One live tick: her lost (gone from the room, past FORGET_M, above ABOVE_M, or a peer's anchor stale) and it forgets her; a swing runs out, its blow landing BLOW_AT through if she is still in reach; else it swings at her within REACH_M or goes after her. */
  _stepLive(c, k) {
    const live = c.live
    const p = this._player(live.by)
    const fresh = live.by === null || (live.anchor !== null && k * TICK_S - live.anchor[1] < ANCHOR_STALE_S)
    const d = p === null ? Infinity : Math.hypot(p.x - c.sx, p.z - c.sz)
    if (!fresh || d > FORGET_M || p.y - c.sy > ABOVE_M) { this._unlive(c, k); return }
    if (c.state === 'swing') {
      c.aim = Math.atan2(-(p.z - c.sz), p.x - c.sx)
      this._turn(c)
      if (k === c.blowTick && live.by === null && d <= REACH_M + SLACK_M) this.owed += BLOW
      if (k >= c.stepEnd) { c.state = 'chase'; this._play(c, 'walk', k, CHASE_SPEED) }
    } else if (d <= REACH_M) {
      c.state = 'swing'
      const n = ticksOf(this.durations.threaten / SWING_RATE)
      this._play(c, 'threaten', k, 0, k + n)
      c.blowTick = k + Math.round(n * BLOW_AT)
    } else {
      this._go(c, p.x, p.z, CHASE_SPEED, k)
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

  _step(c, k) {
    c.lx = c.sx; c.ly = c.sy; c.lz = c.sz; c.lh = c.sh
    if (k >= c.turnTick) {
      // At the chapter turn one not live is on its round, so a joiner past the relay's memory of its anchor lays it where every resident has it.
      c.turnTick += CHAPTER_S * TICK_HZ
      if (c.state === 'back') this._toRound(c, k)
    }
    if (c.live) { this._stepLive(c, k); return }
    roundAt(c.round, k * TICK_S, _at)
    if (c.state === 'back') {
      this._go(c, _at.x, _at.z, CHASE_SPEED, k)
      if (Math.hypot(_at.x - c.sx, _at.z - c.sz) < ARRIVE_M) c.state = 'round'
    } else {
      const dx = _at.x - c.sx, dz = _at.z - c.sz
      if (dx * dx + dz * dz > 1e-8) c.aim = Math.atan2(-dz, dx)
      this._turn(c)
      c.sx = _at.x; c.sz = _at.z
      c.sy = this.walk.heightAt(c.sx, c.sz)
      const clip = _at.moving ? 'walk' : 'idle'
      if (c.clip !== clip) this._play(c, clip, k, ROUND_SPEED)
    }
    const dx = this.hx - c.sx, dz = this.hz - c.sz
    if (dx * dx + dz * dz < NOTICE_M * NOTICE_M && this.hy - c.sy <= ABOVE_M && Math.abs(swing(c.sh, Math.atan2(-dz, dx))) < Math.PI / 2) this._golive(c, null, k)
  }

  _pose(c) {
    const a = c.rec.alpha
    c.x = lerp(c.lx, c.sx, a)
    c.y = lerp(c.ly, c.sy, a)
    c.z = lerp(c.lz, c.sz, a)
    c.heading = c.lh + swing(c.lh, c.sh) * a
  }

  /** One frame at world time `now`: a giant laid for each labyrinth within LAY_M of her head (hx, hy, hz), each stepped to `now` and drawn. `peers` the other players' heads, each `{ x, y, z, by }`. */
  update(hx, hy, hz, now, peers, dt) {
    if (!this.loaded) return this.lazy.want()
    if (!Number.isFinite(now)) throw new Error(`Giants.update needs the world time, got ${now}`)
    this.hx = hx; this.hy = hy; this.hz = hz
    this.peers = peers
    this.frame++
    const sites = this.labyrinths.sitesIn(hx - LAY_M, hz - LAY_M, hx + LAY_M, hz + LAY_M, _sites)
    for (const c of this.slots) if (c.laid && !sites.includes(c.site)) this._unlay(c)
    for (const s of sites) {
      if (this.slots.some((c) => c.laid && c.site === s)) continue
      const c = this.slots.find((q) => !q.laid)
      if (!c) throw new Error(`Giants: more than ${MAX} labyrinths within ${LAY_M} m`)
      this._lay(c, s, now)
    }
    for (const c of this.slots) if (c.laid) this._tick(c, now, dt)
  }

  _tick(c, now, dt) {
    const want = tickOf(now)
    if (want - c.rec.at > CATCH_UP_TICKS) this._replace(c, now)
    c.rec.at = want
    stepTo(c.rec, now, (k) => this._step(c, k))
    if (c.rec.tick < want) return
    this._pose(c)
    c.lod = critterTier(HEIGHT_M, Math.hypot(c.x - this.hx, c.y - this.hy, c.z - this.hz), c.lod, LOD_TIERS)
    const show = c.lod === LOD_TIERS ? -1 : c.lod
    if (show === -1 && !c.puppet) return
    if (!c.puppet) {
      c.puppet = this.freePuppets.pop()
      this.batch.add(c.puppet.group)
      c.puppet.play(c.clip, c.cue, (c.rec.tick - c.stepStart) * TICK_S * c.rate)
    }
    const puppet = c.puppet
    puppet.show(show)
    _pos.set(c.x, c.y, c.z)
    _quat.setFromAxisAngle(UP, c.heading)
    _scl.setScalar(c.k)
    _mat.compose(_pos, _quat, _scl)
    puppet.play(c.clip, c.cue)
    puppet.mixer.timeScale = c.rate
    groundFeet(puppet, c, this.walk, PLANTED, (this.frame + c.id) % REPLANT_EVERY === 0)
    puppet.step(dt)
    puppet.group.matrix.copy(_mat)
    puppet.group.matrixWorldNeedsUpdate = true
    if (puppet.done) {
      puppet.release()
      this.batch.remove(puppet.group)
      this.freePuppets.push(puppet)
      c.puppet = null
    }
  }

  dispose() {
    this.batch.parent?.remove(this.batch)
    for (const m of this.materials) m.dispose()
    this.asset?.map?.dispose()
    for (const geo of this.asset?.tiers ?? []) geo.dispose()
  }
}
