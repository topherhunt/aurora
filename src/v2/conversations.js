// Talking with the townsfolk and the leafkin (_notes/conversation-and-quests.md, "Conversation"): their chatter with
// each other voiced where they stand, her hail (a spike on the mic, or a key) to whomever she faces, the dialog panel
// while they talk, and now and then one who comes to her unasked -- outdoors, or the residents of the house she is in.
// The words are talk/*; this is when and where.

import { TalkWorld } from './talk/world.js'
import { villageMinds } from './talk/mind.js'
import { Chat, chatterStep, wantsHer } from './talk/chat.js'
import * as trade from './talk/trade.js'
import { TILE } from './render/roosts.js'
import { DialogGrid, GRID } from './talk/grid.js'
import { LinePicker, leafkinTier } from './talk/lines.js'
import { epochOf, questsFor } from './talk/quests.js'
import { RAPPORT } from './talk/rapport.js'
import { LK } from './talk/leafkin.js'
import { Voices } from './audio/voices.js'
import { jeer, swordWarning } from './talk/armed.js'
import { DialogPanel } from './ui/dialog-panel.js'
import { ghostSays } from './talk/ghost.js'

export const TALK = {
  // Metres, at her scale: whom a hail reaches, and past which a conversation is over.
  hail: 3,
  leave: 4.5,
  // Her gaze must be within acos(face) of them.
  face: 0.85,
  // Seconds their last line stays up, past its reading at `wordsPerS`.
  linger: 2.5,
  wordsPerS: 3,
  // Mouth height over the feet, of their height.
  mouth: 0.9,
  // Seconds between looks for someone to come to her; how near they must be, how close they come, how long they wait, and how long before the same one is asked again.
  approach: { every: 6, m: 12, come: 1.4, wait: 15, again: 300 },
  // Her with a sword in town: seconds between looks for a passer-by to jeer, within `m` m, each at most once an `again`.
  jeer: { every: 4, m: 6, again: 90 },
  // Seconds past which a pair's next turn is a fresh conversation.
  pairGap: 30,
  // Seconds a hailed one takes to turn to her before answering, at least and at most.
  answer: [1.2, 1.8],
}

const EMPTY = Array.from({ length: GRID.cols * GRID.rows }, () => ({ text: '', kind: 'empty' }))
const FREE = new Set(['walk', 'stand', 'gaze', 'sit', 'talk', 'greet', 'peer', 'court', 'chide'])

export class Conversations {
  /**
   * `towns` planTowns' (the same `townsfolk.towns`); `villagers` the room's leafkin village or null, `villageSeed` its
   * seed. `known`, `rapport` and `log` outlive the room (main.js). `upload` puts a canvas on the GPU; `engine()` is the
   * SoundEngine once it is open and `mic()` her Mic once asked for, else null. `pack` is what she carries (main.js),
   * `roosts` the dragon roosts or null in a village (the deer town stands near one), and `wrongs` the glade she wronged:
   * `{ wronged(): boolean, witness(): villager id or null }`. `heard(p)` puts a point {x, y, z} where her ears hear it, in place.
   * `hideouts` each town's (quests.js hideouts), or null in a village.
   */
  constructor(scene, { seed, towns, townsfolk, villagers, villageSeed, known, rapport, log, upload, engine, mic, pack, roosts, wrongs, heard, hideouts }) {
    this.world = new TalkWorld(seed, towns)
    if (hideouts !== null) this.world.seatHideouts(hideouts)
    this.pack = pack
    this.wrongs = wrongs
    this.heard = heard
    if (roosts) {
      const sites = []
      for (const { town } of this.world.towns) {
        const tx = Math.floor(town.x / TILE), tz = Math.floor(town.z / TILE)
        for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
          const site = roosts.siteAt(tx + dx, tz + dz)
          if (site) sites.push(site)
        }
      }
      this.world.seatDeer(sites)
    }
    this.townsfolk = townsfolk
    this.villagers = villagers
    this.village = villagers ? villageMinds(villageSeed, villagers.all.length, villagers.all.map((c) => villagers.graph.doorNodes.indexOf(c.home))) : []
    this.known = known
    this.rapport = rapport
    this.log = log
    this.engine = engine
    this.panel = new DialogPanel(scene, upload)
    this.grid = new DialogGrid()
    this.picker = null
    fetch('sounds/voice/moments.json').then((r) => {
      if (!r.ok) throw new Error(`Conversations: moments.json answered ${r.status}`)
      return r.json()
    }).then((table) => { this.picker = new LinePicker(table, seed) })
    this.voices = null
    this.mic = mic
    this.now = 0
    this.epoch = null
    this.quests = null
    this.chat = null
    this.coming = null
    this.hailed = false
    // Random per session, so a talk's wording is not the same each time the game loads.
    this.salt = (Math.random() * 2 ** 30) | 0
    // Seconds until which each person leaves her be, and until which each is not asked to come to her again, by mind id.
    this.alone = new Map()
    this.asked = new Map()
    this.pairs = new Map()
    this.turns = []
    // A chider's scold, a passer-by's jeer or a ghost's word on the panel with no conversation open: `{ c, until, ghost }` (`ghost` a ghost's quest id, else null), or null.
    this.scold = null
    // The ghost quest whose ghost has spoken to her since she last came near it, or null.
    this.haunting = null
    // The house she is in, `{ residents, t }` (`t` its town, null in a village), or null: its residents are whom she talks with.
    this.room = null
    // Seconds until which each townsperson leaves her sword be, by mind id; the alive towns whose guard has warned her off it.
    this.jeered = new Map()
    this.warned = new Set()
  }

  /** The key's stand-in for her voice. */
  hail() {
    this.hailed = true
  }

  get open() {
    return this.chat !== null
  }

  dispose() {
    if (this.chat) this._end()
    if (this.coming) this._unhold(this.coming.p)
    this.panel.group.removeFromParent()
  }

  /** The talk's view of the moment with `p.mind` (null for chatter, which trades nothing). */
  _ctx(p, mind = null) {
    const epoch = this._refresh()
    const held = this.pack.held()
    const wants = mind !== null && held !== null && trade.wants(mind, held) ? held : null
    const leaf = mind !== null && mind.kind === 'leafkin'
    const witness = this.wrongs.witness()
    return {
      world: this.world, rapport: this.rapport, quests: this.quests, log: this.log, epoch, from: { x: p.c.pose.x, z: p.c.pose.z }, hour: this.hour, known: this.known,
      pack: this.pack, wants, inWorkshop: mind !== null && this._inWorkshop(p, mind), inShop: mind !== null && this._inShop(p, mind), armed: p.kind === 'town' && this.pack.holds('sword'),
      wronged: leaf && this.wrongs.wronged(), witness: leaf && witness !== null ? this.village[witness].id : null,
    }
  }

  /** The quests live now, rolled afresh each epoch but for a missing child she has taken on and not seen home: that one stays until she has. Returns the epoch. */
  _refresh() {
    const epoch = epochOf(this.now)
    if (epoch === this.epoch) return epoch
    this.epoch = epoch
    this.quests = questsFor(this.world, epoch)
    for (const { quest, state } of this.log.of.values()) {
      if (quest.kind !== 'missing-child' || state === 'done') continue
      for (const [id, q] of this.quests) if (q.kind === 'missing-child' && q.town === quest.town) this.quests.delete(id)
      this.quests.set(quest.id, quest)
    }
    return epoch
  }

  /** The missing children out there now, each `{ quest, child }` (`child` the townsperson's mind). */
  lost(into = []) {
    this._refresh()
    for (const q of this.quests.values()) {
      if (q.kind !== 'missing-child') continue
      const state = this.log.state(q.id)
      if (state !== 'found' && state !== 'done') into.push({ quest: q, child: this.world.person(q.child) })
    }
    return into
  }

  /** Each missing child kept out of their town (Townsfolk.setMissing), told only when the set changes. */
  _hide() {
    const keys = new Set(this.lost().map(({ child }) => `${child.town}:${child.index}`))
    const was = this.townsfolk.missing
    if (keys.size !== was.size || [...keys].some((k) => !was.has(k))) this.townsfolk.setMissing(keys)
  }

  /** She has found quest `id`'s child, who goes home; taken on now if she never was asked. */
  found(id) {
    const q = this.quests.get(id)
    if (q === undefined) throw new Error(`Conversations: no quest ${id}`)
    this.log.accept(q)
    this.log.set(id, 'found')
  }

  /** The message quest of castle `site`'s ghost (quests.js ghostMessage), or null when no ghost haunts it. */
  ghostOf(site) {
    this._refresh()
    for (const q of this.quests.values()) if (q.kind === 'message' && q.ghost !== null && q.ghost.site === site) return q
    return null
  }

  /**
   * Once a frame in its castle: ghost quest `q`'s ghost floating `at` ({ x, y, z }, its feet) speaks (talk/ghost.js) on the
   * panel as she comes within `near` m of it, once each time she comes, calling `spoke()` as it does. Returns whether it
   * is still there to be drawn: until it is at rest and its last line has been read.
   */
  haunt(q, at, head, near, spoke) {
    const d = Math.hypot(at.x - head.x, at.z - head.z)
    if (d > 1.5 * near) this.haunting = null
    else if (d < near && this.haunting !== q.id && this.chat === null) {
      this.haunting = q.id
      const line = ghostSays(q, this.log, this.world)
      if (line !== null) {
        this.scold = { c: { pose: at }, until: this.now + TALK.linger + line.text.split(' ').length / TALK.wordsPerS, ghost: q.id }
        this.panel.show(q.ghost.name, line.text, EMPTY)
        spoke()
        const voice = { pack: q.ghost.she ? 'woman' : 'man', he: !q.ghost.she, rate: 0.92, tilt: -2 }
        this.bark({ id: `ghost:${q.id}`, kind: 'human', voice }, 'castle.ghost', { x: at.x, y: at.y + 1.5, z: at.z }, head, { reply: true })
      }
    }
    return this.log.state(q.id) !== 'done' || (this.scold !== null && this.scold.ghost === q.id)
  }

  /** A line for `moment` from `mind`, one with no town (castle folk, a ghost), at its `mouth` ({ x, y, z }); `reply` always plays,
   * `only` limits it to those utterance ids. */
  bark(mind, moment, mouth, head, { reply = false, only = null } = {}) {
    if (this.picker === null || this.voices === null && !this._voices()) return
    const pick = this.picker.pick(mind, moment, { now: this.now, force: reply, only })
    if (pick !== null) this.voices.say(pick, mouth, Math.hypot(mouth.x - head.x, mouth.y - head.y, mouth.z - head.z), { reply })
  }

  /** `text` on the panel as `name`'s over world point `at` ({ x, y, z }) unless she is talking, for as long as a scold's. */
  say(name, text, at) {
    if (this.chat !== null) return
    this.scold = { c: { pose: at }, until: this.now + TALK.linger + text.split(' ').length / TALK.wordsPerS, ghost: null }
    this.panel.show(name, text, EMPTY)
  }

  /** Whether the smith `mind` stands at his workshop (a smith with none is always in it); false for anyone else. */
  _inWorkshop(p, mind) {
    if (!trade.isSmith(mind)) return false
    if (mind.work === null) return true
    const w = this.world.townOf(mind).town.works[mind.work]
    return Math.hypot(p.c.pose.x - w.x, p.c.pose.z - w.z) < 8
  }

  /** Whether the alchemist `mind` stands in the potion shop; false for anyone else. */
  _inShop(p, mind) {
    if (!trade.isAlchemist(mind)) return false
    const t = this.world.townOf(mind).town
    const shop = t.buildings.find((b) => b.trade === 'potions')
    if (shop === undefined) throw new Error(`Conversations: town of ${mind.id} has no potion shop`)
    return Math.hypot(p.c.pose.x - shop.x, p.c.pose.z - shop.z) < 8
  }

  /** Townsperson `id` of alive town `t`, or null for a traveller, who has no mind. */
  _townMind(t, id) {
    const entry = this.world.towns[t]
    if (entry.town !== this.townsfolk.towns[t]) throw new Error(`Conversations: town ${t} is not the townsfolk's`)
    return entry.minds[id] ?? null
  }

  /** The house's residents (render/residents.js, town-residents.js) she is among, or null outdoors. */
  get _res() {
    return this.room === null ? null : this.room.residents
  }

  /** Everyone drawn near enough to talk to: `{ kind, c, mind, t, res }`, `res` the residents `c` is one of, else null. */
  _people(into) {
    if (this.room !== null) {
      const { residents: res, t } = this.room
      for (const c of res.talkers([])) {
        const mind = t === null ? this.village[c.id] : this._townMind(t, c.id)
        if (mind !== null) into.push({ kind: t === null ? 'village' : 'town', c, mind, t, res })
      }
      return into
    }
    if (this.townsfolk) {
      for (const [t, { life }] of this.townsfolk.alive) {
        for (const c of life.all) {
          if (!c.puppet || c.missing || (c.hidden && c.greet === null)) continue
          const mind = this._townMind(t, c.id)
          if (mind !== null) into.push({ kind: 'town', c, mind, t, res: null })
        }
      }
    }
    if (this.villagers) for (const c of this.villagers.all) if (c.puppet && !c.hidden) into.push({ kind: 'village', c, mind: this.village[c.id], res: null })
    return into
  }

  /** Once a frame. `head` her eye, `gaze` her look flattened to a unit {x, z}, `scale` hers, `trusts(id)` whether villager `id` trusts her; `room` the house she is in (this.room), `indoors` whether she is somewhere no one talks (a cave). */
  update(dt, { seconds, head, gaze, scale, hour, trusts, indoors, room }) {
    this.now = seconds
    if (this.townsfolk) this._hide()
    this.hour = hour
    this.trusts = trusts
    this.room = room
    const away = indoors || room !== null
    if (away) this._drain()
    else this._chatter(head)
    if (this.coming && this.coming.p.res !== this._res) { this._unhold(this.coming.p); this.coming = null }
    if (this.chat) this._keep(head, scale, indoors)
    else if (this.scold) this._keepScold(head, scale, away)
    const mic = this.mic()
    const spoke = (mic !== null && mic.spike(seconds, dt)) || this.hailed
    this.hailed = false
    if (spoke && this.chat === null && !indoors) this._hail(head, gaze, scale)
    if (this.townsfolk) for (const t of this.warned) if (!this.townsfolk.alive.has(t)) this.warned.delete(t)
    if (this.chat === null && this.scold === null && !away && Math.floor(seconds / TALK.jeer.every) !== Math.floor((seconds - dt) / TALK.jeer.every)) this._jeer(head, scale)
    if (this.coming) this._wait(head)
    else if (this.chat === null && !indoors && Math.floor(seconds / TALK.approach.every) !== Math.floor((seconds - dt) / TALK.approach.every)) this._approach(head, scale)
  }

  // -- their chatter with each other ----------------------------------------------------------------------------

  _chatter(head) {
    const turns = this.turns
    if (this.townsfolk) for (const v of this.townsfolk.chatter(turns.splice(0))) {
      const mind = this._townMind(v.town, v.id)
      if (mind !== null) this._turn(mind, `${v.town}:${Math.min(v.id, v.partner)}:${Math.max(v.id, v.partner)}`, v.x, v.y, v.z, head)
    }
    if (this.villagers) for (const v of this.villagers.chatter(turns.splice(0))) {
      this._turn(this.village[v.id], `v:${Math.min(v.id, v.partner)}:${Math.max(v.id, v.partner)}`, v.x, v.y, v.z, head)
    }
    if (this.villagers) for (const v of this.villagers.chides(turns.splice(0))) this._scold(v, head)
  }

  /** Their turns unheard, from behind walls. */
  _drain() {
    if (this.townsfolk) this.townsfolk.chatter(this.turns.splice(0))
    if (this.villagers) {
      this.villagers.chatter(this.turns.splice(0))
      this.villagers.chides(this.turns.splice(0))
    }
    this.turns.length = 0
  }

  /** A chider's scold at her (villagers.js chide). */
  _scold(v, head) {
    this._remark({ c: this.villagers.all[v.id], mind: this.village[v.id] }, { text: LK.scold[(Math.random() * LK.scold.length) | 0], moment: 'tell.caught' }, head)
  }

  /** A passer-by's jeer at her sword in town (talk/armed.js), from someone near who is free and no guard. */
  _jeer(head, scale) {
    if (!this.pack.holds('sword')) return
    for (const p of this._people([])) {
      const c = p.c
      if (p.kind !== 'town' || p.mind.cls === 'guard' || c.hidden || c.lag || c.job !== null || c.state === 'work') continue
      if (Math.hypot(c.pose.x - head.x, c.pose.z - head.z) > TALK.jeer.m * scale || (this.jeered.get(p.mind.id) ?? -Infinity) > this.now) continue
      this.jeered.set(p.mind.id, this.now + TALK.jeer.again)
      this._remark(p, jeer(p.mind, Math.random()), head)
      return
    }
  }

  /** `line` ({ text, moment }) called at her by `p` unasked: on the panel over them unless she is talking, and in their voice. */
  _remark(p, line, head) {
    if (this.chat === null) {
      this.scold = { c: p.c, until: this.now + TALK.linger + line.text.split(' ').length / TALK.wordsPerS, ghost: null }
      this.panel.show(p.mind.name, line.text, EMPTY)
    }
    if (this.picker === null || this.voices === null && !this._voices()) return
    const pick = this.picker.pick(p.mind, line.moment, { now: this.now, tier: 'native', force: true })
    if (pick !== null) this.voices.say(pick, this._heard(p.c), this._far(p.c, head), { reply: true })
  }

  _keepScold(head, scale, indoors) {
    if (indoors || this.now >= this.scold.until) { this.scold = null; this.panel.hide(); return }
    this.panel.place(head, this.scold.c.pose, scale)
  }

  /** `mind`'s turn in its pair's chatter: the next step of their exchange (chat.js EXCHANGES), which only a line heard moves on. */
  _turn(mind, pair, x, y, z, head) {
    if (this.chat !== null && this.chat.p.mind === mind) return
    if (this.picker === null || this.voices === null && !this._voices()) return
    const was = this.pairs.get(pair)
    const step = chatterStep(mind, this._ctx({ c: { pose: { x, z } } }, mind), was === undefined || this.now - was.time > TALK.pairGap ? null : was.at, { hour: this.hour, r: Math.random(), alt: Math.random() })
    if (step === null) return
    if (step.moment === null) { this.pairs.set(pair, { at: step.at, time: this.now }); return }
    const pick = this.picker.pick(mind, step.moment, { now: this.now, tier: 'native', only: step.only })
    if (pick === null) return
    this.pairs.set(pair, { at: step.at, time: this.now })
    this.voices.say(pick, { x, y, z }, Math.hypot(x - head.x, y - head.y, z - head.z))
  }

  _voices() {
    const engine = this.engine()
    if (engine !== null) this.voices = new Voices(engine)
    return this.voices !== null
  }

  // -- her conversation ---------------------------------------------------------------------------------------

  /** Whom she faces within reach, or null. */
  _faced(head, gaze, scale, people) {
    let best = null, bestCos = TALK.face
    for (const p of people) {
      const dx = p.c.pose.x - head.x, dz = p.c.pose.z - head.z, d = Math.hypot(dx, dz)
      if (d > TALK.hail * scale || d === 0) continue
      const cos = (dx * gaze.x + dz * gaze.z) / d
      if (cos > bestCos) { best = p; bestCos = cos }
    }
    return best
  }

  _hail(head, gaze, scale) {
    const p = this._faced(head, gaze, scale, this._people([]))
    if (p === null) return
    // One who came to her and waits is already facing her, and answers at once.
    const approached = this.coming !== null && this.coming.p.mind === p.mind && this.coming.hailed
    if (this.coming && this.coming.p.mind !== p.mind) this._unhold(this.coming.p)
    this.coming = null
    this.scold = null
    const trusted = p.kind === 'village' ? this.trusts(p.c.id) : true
    // A leafkin that trusts her is at least as warm as a fed one (RAPPORT.fed).
    if (p.kind === 'village' && trusted) {
      const warmth = this.rapport.get(p.mind.id).warmth
      if (warmth < RAPPORT.fed) this.rapport.warm(p.mind.id, RAPPORT.fed - warmth)
    }
    this._hold(p)
    const chat = new Chat(p.mind, this._ctx(p, p.mind), { trusted, busy: this._busy(p), approached, salt: this.salt++ })
    const [lo, hi] = TALK.answer
    this.chat = { p, chat, closing: null, trusted, answerAt: approached ? this.now : this.now + lo + Math.random() * (hi - lo) }
    this.grid.reset()
  }

  /** Their first line, once they have turned to her. */
  _open(head) {
    const { p, chat } = this.chat
    this.chat.answerAt = null
    // Left be, they turn her off before a word is weighed.
    const line = (this.alone.get(p.mind.id) ?? -Infinity) > this.now ? chat._end(chat.conv._line(p.mind.kind === 'leafkin' ? 'Go. Bye.' : 'Not now.', 'talk-shrug', { moment: 'mood.busy' }), 'declined') : chat.open()
    this._answer(line, head)
  }

  _busy(p) {
    if (p.res !== null) return false
    return p.kind === 'town' ? p.c.state === 'work' || p.c.job !== null : !FREE.has(p.c.state)
  }

  /** Cell `hit` (a raycast hit) pressed on the dialog grid: whether the panel took it. */
  press(hit, head) {
    if (this.chat === null || this.chat.answerAt !== null) return false
    const i = this.panel.indexAt(hit)
    if (i < 0) return false
    if (this.chat.closing !== null) return true
    const menu = this.chat.chat.conv.menu()
    const topic = this.grid.press(menu, i)
    if (topic === null) this.panel.setCells(this.grid.cells(menu))
    else this._answer(this.chat.chat.ask(topic), head)
    return true
  }

  _answer(line, head) {
    const { p, chat } = this.chat
    this._say(p, line, head)
    if (line.ended) {
      this.alone.set(p.mind.id, this.now + line.alone)
      this.chat.closing = this.now + TALK.linger + line.text.split(' ').length / TALK.wordsPerS
      this.panel.show(p.mind.name, line.text, EMPTY)
    } else this.panel.show(p.mind.name, line.text, this.grid.cells(chat.conv.menu()))
  }

  /** `line` said by `p`: its gesture, and its moment in their voice where she stands. */
  _say(p, line, head) {
    if (p.res !== null) p.res.gesture(p.c, line.gesture, line.toward)
    else if (p.kind === 'town') this.townsfolk.gesture(p.c, line.gesture, this.now, line.toward)
    else this.villagers.gesture(p.c.id, line.gesture, this.now, line.toward)
    if (this.picker === null || this.voices === null && !this._voices()) return
    const tier = p.kind === 'village' ? leafkinTier(this.chat.trusted, this.rapport.standing(p.mind.id)) : 'native'
    const pick = this.picker.pick(p.mind, line.moment, { now: this.now, tier, force: true })
    if (pick === null) return
    this.voices.say(pick, this._heard(p.c), this._far(p.c, head), { reply: true })
  }

  /** `c`'s mouth where her ears hear it (`heard`: a house's room is heard out at its door). */
  _heard(c) {
    return this.heard({ x: c.pose.x, y: c.pose.y + TALK.mouth * c.size, z: c.pose.z })
  }

  /** Metres from `c`'s mouth to her `head`. */
  _far(c, head) {
    return Math.hypot(c.pose.x - head.x, c.pose.y + TALK.mouth * c.size - head.y, c.pose.z - head.z)
  }

  /** The open conversation kept up: the panel before her, or over once she walks off or their last line has been read. */
  _keep(head, scale, indoors) {
    const { p, closing } = this.chat
    const d = Math.hypot(p.c.pose.x - head.x, p.c.pose.z - head.z)
    if (indoors || p.res !== this._res || (p.res !== null && !p.res.held(p.c)) || d > TALK.leave * scale || (closing !== null && this.now >= closing)) { this._end(); return }
    if (this.chat.answerAt !== null) {
      if (this.now < this.chat.answerAt) return
      this._open(head)
    }
    this.panel.place(head, p.c.pose, scale)
  }

  _end() {
    this._unhold(this.chat.p)
    this.chat = null
    this.panel.hide()
    this.grid.reset()
  }

  _hold(p) {
    if (p.res !== null) p.res.hold(p.c)
    else if (p.kind === 'town') this.townsfolk.hold(p.c, this.now)
    else this.villagers.hold(p.c.id, this.now)
  }

  _unhold(p) {
    if (p.res !== null) p.res.release(p.c)
    else if (p.kind === 'town') this.townsfolk.release(p.c, this.now)
    else this.villagers.release(p.c.id)
  }

  // -- one who comes to her ------------------------------------------------------------------------------------

  /** Now and then someone near her and free -- a leafkin only if it trusts her -- comes over, if they want something of her or are the friendly sort. Each is asked once an `again` about the item in her hand, and once about nothing. With a sword in her hand in town, only a guard comes, once a visit, to warn her off it. */
  _approach(head, scale) {
    const A = TALK.approach
    const armed = this.pack.holds('sword')
    for (const p of this._people([])) {
      const c = p.c, id = p.mind.id
      if (p.res !== null ? !p.res.free(c) || (p.kind === 'village' && !this.trusts(c.id)) : p.kind === 'town' ? c.greet !== null || c.lag || c.hidden || c.job !== null || c.state === 'work' || c.state === 'sit' : this.villagers.talking.has(c.id) || !FREE.has(c.state) || !this.trusts(c.id)) continue
      if (Math.hypot(c.pose.x - head.x, c.pose.z - head.z) > A.m * scale) continue
      if (armed && p.kind === 'town' && p.res === null) {
        if (p.mind.cls !== 'guard' || this.warned.has(p.t)) continue
        this.warned.add(p.t)
        this.townsfolk.approach(c, this.now, A.come * scale)
        this.coming = { p, until: Infinity, hailed: false, warn: true }
        return
      }
      if ((this.alone.get(id) ?? -Infinity) > this.now) continue
      const ctx = this._ctx(p, p.mind)
      const ask = ctx.wants === null ? id : `${id}:${ctx.wants}`
      if ((this.asked.get(ask) ?? -Infinity) > this.now) continue
      this.asked.set(ask, this.now + A.again)
      if (!wantsHer(p.mind, ctx, Math.random())) continue
      if (p.res !== null) { if (!p.res.approach(c, A.come * scale)) continue }
      else if (p.kind === 'town') this.townsfolk.approach(c, this.now, A.come * scale)
      else this.villagers.approach(c.id, this.now, A.come * scale)
      this.coming = { p, until: Infinity, hailed: false, warn: false }
      return
    }
  }

  /** The one coming to her: hails her once there and waits; left waiting, goes back to what it was doing. */
  _wait(head) {
    const { p } = this.coming
    const greet = p.res !== null ? (p.res.held(p.c) ? { at: p.res.arrived(p.c) ? 0 : Infinity } : null) : p.kind === 'town' ? p.c.greet : this.villagers.talking.get(p.c.id)
    if (!greet) { this.coming = null; return }
    if (!this.coming.hailed && greet.at !== Infinity) {
      this.coming.hailed = true
      this.coming.until = this.now + TALK.approach.wait
      if (this.coming.warn) this._remark(p, swordWarning(p.mind, Math.random()), head)
      else if (this.picker !== null && (this.voices !== null || this._voices())) {
        const pick = this.picker.pick(p.mind, 'hail.attention', { now: this.now, force: true })
        if (pick !== null) this.voices.say(pick, this._heard(p.c), TALK.approach.come)
      }
    }
    if (this.now >= this.coming.until) {
      this._unhold(p)
      this.coming = null
    }
  }
}
