// People's recorded speech (_notes/conversation-and-quests.md, "Voice"): each voice pack (tools/voice/pack.mjs) is
// fetched whole the first time anyone in it speaks, and a line is decoded only when it plays, kept in a small LRU.
// Speech is placed at the speaker: bright and close beside her, darker and echoed with distance, gone past `reach`.

export const SPEECH = {
  // Metres past which nobody is heard, and the span before it over which they fade out.
  reach: 20,
  edge: 5,
  // Full level within this; past it, level falls as near / d.
  near: 2,
  level: 0.9,
  // Within this a voice is crisp (the engine's `bright`).
  brightM: 3.5,
  // The engine's air dulling and reverb times this: voices lose their edge faster than a thunderclap.
  air: 5,
  // Echo send at the reach, from nothing at brightM.
  echo: 0.35,
  // Lines at once, a conversation reply always among them.
  speaking: 2,
  // Decoded lines kept.
  cache: 48,
}

export class Voices {
  /** `engine` a SoundEngine; packs are read from `base`. */
  constructor(engine, base = 'sounds/voice/') {
    this.engine = engine
    this.base = base
    this.packs = new Map()
    this.decoded = new Map()
    this.playing = new Set()
  }

  _pack(pack) {
    let p = this.packs.get(pack)
    if (p === undefined) {
      p = Promise.all([fetchOk(`${this.base}${pack}.json`).then((r) => r.json()), fetchOk(`${this.base}${pack}.mp3`).then((r) => r.arrayBuffer())]).then(([index, bytes]) => ({ lines: index.lines, bytes }))
      this.packs.set(pack, p)
    }
    return p
  }

  /** Line `line` of `pack` decoded and in the engine's buffers: its clip name. */
  async _decode(pack, line) {
    const name = `voice:${pack}:${line}`
    let job = this.decoded.get(name)
    if (job !== undefined) {
      // Refresh its place in the LRU.
      this.decoded.delete(name)
      this.decoded.set(name, job)
      return job
    }
    job = this._pack(pack).then(async ({ lines, bytes }) => {
      const at = lines[line]
      if (at === undefined) throw new Error(`Voices: ${pack} has no line ${line}`)
      this.engine.buffers.set(name, await this.engine.ctx.decodeAudioData(bytes.slice(at[0], at[0] + at[1])))
      return name
    })
    this.decoded.set(name, job)
    while (this.decoded.size > SPEECH.cache) {
      const [old] = this.decoded.keys()
      this.decoded.delete(old)
      this.engine.buffers.delete(old)
    }
    return job
  }

  /** How loud a voice `d` metres off is, 0 past the reach. */
  static level(d) {
    const fade = Math.max(0, Math.min(1, (SPEECH.reach - d) / SPEECH.edge))
    return (SPEECH.level * SPEECH.near * fade) / Math.max(SPEECH.near, d)
  }

  /**
   * Say `pick` (talk/lines.js `{ pack, line, rate, tilt }`) from `at` {x, y, z}, `d` metres from her. `reply` is a
   * conversation line, which always plays. Resolves to the seconds it runs, or 0 when it is not heard.
   */
  async say(pick, at, d, { reply = false } = {}) {
    if (d >= SPEECH.reach || (!reply && this.playing.size >= SPEECH.speaking)) return 0
    const name = await this._decode(pick.pack, pick.line)
    const far = Math.max(0, Math.min(1, (d - SPEECH.brightM) / (SPEECH.reach - SPEECH.brightM)))
    const src = this.engine.play(name, { at, rate: pick.rate, tilt: pick.tilt, gain: Voices.level(d), distance: d, air: SPEECH.air, echo: SPEECH.echo * far, bright: d < SPEECH.brightM, walled: true })
    if (src === null) return 0
    this.playing.add(src)
    src.addEventListener('ended', () => this.playing.delete(src))
    return this.engine.duration(name) / pick.rate
  }
}

async function fetchOk(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Voices: ${url} answered ${res.status}`)
  return res
}
