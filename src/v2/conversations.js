// Talking with the townsfolk and the leafkin (_notes/conversation-and-quests.md, "Conversation"): their chatter with
// each other voiced where they stand, her hail (a spike on the mic, or a key) to whomever she faces, the dialog panel
// while they talk, and now and then one who comes to her unasked. The words are talk/*; this is when and where.

import { TalkWorld } from './talk/world.js'
import { villageMinds } from './talk/mind.js'
import { Chat, chatterStep, wantsHer } from './talk/chat.js'
import * as trade from './talk/trade.js'
import { TILE } from './render/roosts.js'
import { DialogGrid, GRID } from './talk/grid.js'
import { LinePicker, leafkinTier } from './talk/lines.js'
import { epochOf, questsFor } from './talk/quests.js'
import { RAPPORT } from './talk/rapport.js'
import { Voices } from './audio/voices.js'
import { DialogPanel } from './ui/dialog-panel.js'

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
  // Seconds past which a pair's next turn is a fresh conversation.
  pairGap: 30,
  // Seconds a hailed one takes to turn to her before answering, at least and at most.
  answer: [1.2, 1.8],
}

const EMPTY = Array.from({ length: GRID.cols * GRID.rows }, () => ({ text: '', kind: 'empty' }))
const FREE = new Set(['walk', 'stand', 'gaze', 'sit', 'talk', 'greet', 'peer', 'court'])

export class Conversations {
  /**
   * `towns` planTowns' (the same `townsfolk.towns`); `villagers` the room's leafkin village or null, `villageSeed` its
   * seed. `known`, `rapport` and `log` outlive the room (main.js). `upload` puts a canvas on the GPU; `engine()` is the
   * SoundEngine once it is open and `mic()` her Mic once asked for, else null. `pack` is what she carries (main.js),
   * `roosts` the dragon roosts or null in a village (the deer town stands near one), and `wrongs` the glade she wronged:
   * `{ wronged(): boolean, witness(): villager id or null }`.
   */
  constructor(scene, { seed, towns, townsfolk, villagers, villageSeed, known, rapport, log, upload, engine, mic, pack, roosts, wrongs }) {
    this.world = new TalkWorld(seed, towns)
    this.pack = pack
    this.wrongs = wrongs
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
    const epoch = epochOf(this.now)
    if (epoch !== this.epoch) {
      this.epoch = epoch
      this.quests = questsFor(this.world, epoch)
    }
    const held = this.pack.held()
    const wants = mind !== null && held !== null && trade.wants(mind, held) ? held : null
    const leaf = mind !== null && mind.kind === 'leafkin'
    const witness = this.wrongs.witness()
    return {
      world: this.world, rapport: this.rapport, quests: this.quests, log: this.log, epoch, from: { x: p.c.pose.x, z: p.c.pose.z }, hour: this.hour, known: this.known,
      pack: this.pack, wants, inWorkshop: mind !== null && this._inWorkshop(p, mind),
      wronged: leaf && this.wrongs.wronged(), witness: leaf && witness !== null ? this.village[witness].id : null,
    }
  }

  /** Whether the smith `mind` stands at his workshop (a smith with none is always in it); false for anyone else. */
  _inWorkshop(p, mind) {
    if (!trade.isSmith(mind)) return false
    if (mind.work === null) return true
    const w = this.world.townOf(mind).town.works[mind.work]
    return Math.hypot(p.c.pose.x - w.x, p.c.pose.z - w.z) < 8
  }

  /** Townsperson `id` of alive town `t`, or null for a traveller, who has no mind. */
  _townMind(t, id) {
    const entry = this.world.towns[t]
    if (entry.town !== this.townsfolk.towns[t]) throw new Error(`Conversations: town ${t} is not the townsfolk's`)
    return entry.minds[id] ?? null
  }

  /** Everyone drawn near enough to talk to: `{ kind, c, mind }`. */
  _people(into) {
    if (this.townsfolk) {
      for (const [t, { life }] of this.townsfolk.alive) {
        for (const c of life.all) {
          if (!c.puppet || (c.hidden && c.greet === null)) continue
          const mind = this._townMind(t, c.id)
          if (mind !== null) into.push({ kind: 'town', c, mind })
        }
      }
    }
    if (this.villagers) for (const c of this.villagers.all) if (c.puppet && !c.hidden) into.push({ kind: 'village', c, mind: this.village[c.id] })
    return into
  }

  /** Once a frame. `head` her eye, `gaze` her look flattened to a unit {x, z}, `scale` hers, `trusts(id)` whether villager `id` trusts her. */
  update(dt, { seconds, head, gaze, scale, hour, trusts, indoors }) {
    this.now = seconds
    this.hour = hour
    this.trusts = trusts
    if (indoors) this._drain()
    else this._chatter(head)
    if (this.chat) this._keep(head, scale, indoors)
    const mic = this.mic()
    const spoke = (mic !== null && mic.spike(seconds, dt)) || this.hailed
    this.hailed = false
    if (spoke && this.chat === null && !indoors) this._hail(head, gaze, scale)
    if (this.coming) this._wait()
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
  }

  /** Their turns unheard, from behind walls. */
  _drain() {
    if (this.townsfolk) this.townsfolk.chatter(this.turns.splice(0))
    if (this.villagers) this.villagers.chatter(this.turns.splice(0))
    this.turns.length = 0
  }

  /** `mind`'s turn in its pair's chatter: the next step of their exchange (chat.js EXCHANGES), which only a line heard moves on. */
  _turn(mind, pair, x, y, z, head) {
    if (this.chat !== null && this.chat.p.mind === mind) return
    if (this.picker === null || this.voices === null && !this._voices()) return
    const was = this.pairs.get(pair)
    const step = chatterStep(mind, this._ctx({ c: { pose: { x, z } } }, mind), was === undefined || this.now - was.time > TALK.pairGap ? null : was.at, { hour: this.hour, r: Math.random(), alt: Math.random() })
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
    if (p.kind === 'town') this.townsfolk.gesture(p.c, line.gesture, this.now, line.toward)
    else this.villagers.gesture(p.c.id, line.gesture, this.now, line.toward)
    if (this.picker === null || this.voices === null && !this._voices()) return
    const tier = p.kind === 'village' ? leafkinTier(this.chat.trusted, this.rapport.standing(p.mind.id)) : 'native'
    const pick = this.picker.pick(p.mind, line.moment, { now: this.now, tier, force: true })
    if (pick === null) return
    const at = { x: p.c.pose.x, y: p.c.pose.y + TALK.mouth * p.c.size, z: p.c.pose.z }
    this.voices.say(pick, at, Math.hypot(at.x - head.x, at.y - head.y, at.z - head.z), { reply: true })
  }

  /** The open conversation kept up: the panel before her, or over once she walks off or their last line has been read. */
  _keep(head, scale, indoors) {
    const { p, closing } = this.chat
    const d = Math.hypot(p.c.pose.x - head.x, p.c.pose.z - head.z)
    if (indoors || d > TALK.leave * scale || (closing !== null && this.now >= closing)) { this._end(); return }
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
    if (p.kind === 'town') this.townsfolk.hold(p.c, this.now)
    else this.villagers.hold(p.c.id, this.now)
  }

  _unhold(p) {
    if (p.kind === 'town') this.townsfolk.release(p.c, this.now)
    else this.villagers.release(p.c.id)
  }

  // -- one who comes to her ------------------------------------------------------------------------------------

  /** Now and then a townsperson near her and free comes over, if they want something of her or are the friendly sort. */
  _approach(head, scale) {
    const A = TALK.approach
    for (const p of this._people([])) {
      const c = p.c, id = p.mind.id
      if (p.kind !== 'town' || c.greet !== null || c.lag || c.hidden || c.job !== null || c.state === 'work' || c.state === 'sit') continue
      if (Math.hypot(c.pose.x - head.x, c.pose.z - head.z) > A.m * scale) continue
      if ((this.alone.get(id) ?? -Infinity) > this.now || (this.asked.get(id) ?? -Infinity) > this.now) continue
      this.asked.set(id, this.now + A.again)
      if (!wantsHer(p.mind, this._ctx(p, p.mind), Math.random())) continue
      this.townsfolk.approach(c, this.now, A.come * scale)
      this.coming = { p, until: Infinity, hailed: false }
      return
    }
  }

  /** The one coming to her: hails her once there and waits; left waiting, goes back to what it was doing. */
  _wait() {
    const { p } = this.coming
    if (p.c.greet === null) { this.coming = null; return }
    if (!this.coming.hailed && p.c.greet.at !== Infinity) {
      this.coming.hailed = true
      this.coming.until = this.now + TALK.approach.wait
      if (this.picker !== null && (this.voices !== null || this._voices())) {
        const pick = this.picker.pick(p.mind, 'hail.attention', { now: this.now, force: true })
        if (pick !== null) this.voices.say(pick, { x: p.c.pose.x, y: p.c.pose.y + TALK.mouth * p.c.size, z: p.c.pose.z }, TALK.approach.come)
      }
    }
    if (this.now >= this.coming.until) {
      this._unhold(p)
      this.coming = null
    }
  }
}
