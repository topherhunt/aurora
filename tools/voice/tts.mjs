// The adult voices from text (_notes/conversation-and-quests.md, "Voice"): every human reading through ElevenLabs v4
// on OpenRouter, a Scottish accent tag and the reading's acting note before the line. Raw MP3s are cached in
// work/tts/<speaker>/ (a file there is never fetched again); every run re-trims them into work/voices/<voice>/ for
// pack.mjs. The children are baked from these by variants.py.
//
//   node tools/voice/tts.mjs          # dry run: what would be sent, in characters
//   node tools/voice/tts.mjs --yes    # spends OpenRouter credit on the missing lines, then trims all

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { HUMAN } from './atoms.js'
import { cleanTake, encodeWav } from './audio.js'

const WORK = new URL('./work/', import.meta.url)
const MODEL = 'elevenlabs/eleven-v4'
// Pack -> OpenRouter's ElevenLabs voice (a fixed list; no library or designed voices).
const VOICES = { man: 'george', woman: 'alice' }
const RATE = 44100
const AT_ONCE = 4

// A nonverbal said as text would be read aloud: each is an audio tag and a sound to carry it (a tag alone is refused).
const NONVERBAL = {
  chuckle: '[chuckles] Heh heh.', laugh: '[laughs heartily] Ha ha ha!', snort: '[snorts] Pfft.',
  'sigh-long': '[long weary sigh] Haaah...', 'sigh-worried': '[shaky sigh] Hhh...', 'sigh-content': '[contented sigh] Ahhh.',
  huff: '[huffs] Hmph.', hmm: 'Hmmm...', huh: 'Huh?', ah: 'Ah!', tsk: 'Tsk, tsk.',
  'cough-dry': '[short dry cough] Ehem.', 'cough-chesty': '[chesty rattling cough] Khh-hhm.', 'throat-clear': '[clears throat] Ahem.',
  grunt: '[grunts with effort] Hngh!', hup: 'Hup!', oof: 'Oof.', brr: 'Brrr!', sniff: '[sniffs] Snf.',
  yawn: '[big yawn] Hhaaaahh...', stretch: '[satisfied stretching groan] Mmmnnngh.',
}

/** Every line to speak: `[line, text]`, line named as pack.mjs reads it (`id.rN` or `id.rN-form`). */
function lines() {
  const out = []
  for (const ut of HUMAN) {
    const forms = /\{([^}]+)\}/.exec(ut.text)?.[1].split('|')
    ut.reads.forEach((read, i) => {
      const base = `${ut.id}.r${i + 1}`
      const say = (text) => `[Scottish accent] [${read.note}] ${text}`
      if (ut.cat === 'nonverbal') {
        if (NONVERBAL[ut.id] === undefined) throw new Error(`tts: no text for nonverbal ${ut.id}`)
        out.push([base, `[Scottish accent] ${NONVERBAL[ut.id]}`])
      } else if (forms === undefined) out.push([base, say(ut.text)])
      else for (const f of forms) out.push([`${base}-${f.replace(/'s$/, '').toLowerCase()}`, say(ut.text.replace(/\{[^}]+\}/, f))])
    })
  }
  return out
}

function key() {
  const m = /^OPENROUTER_API_KEY=(.*)$/m.exec(readFileSync(new URL('../../.env', import.meta.url), 'utf8'))
  if (m === null || m[1].trim() === '') throw new Error('tts: OPENROUTER_API_KEY is not in .env')
  return m[1].trim().replace(/^['"]|['"]$/g, '')
}

async function speak(auth, voice, input) {
  const r = await fetch('https://openrouter.ai/api/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input, voice, response_format: 'mp3' }),
  })
  if (!r.ok) throw new Error(`tts: ${voice} "${input}": HTTP ${r.status} ${(await r.text()).slice(0, 400)}`)
  return Buffer.from(await r.arrayBuffer())
}

function trim(mp3Path, wavPath) {
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', mp3Path, '-f', 'f32le', '-ac', '1', '-ar', String(RATE), '-'], { maxBuffer: 1 << 26 })
  const clean = cleanTake(new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4), RATE)
  if (clean === null) throw new Error(`tts: ${mp3Path} is silent`)
  writeFileSync(wavPath, Buffer.from(encodeWav(clean, RATE)))
}

const all = lines()
const todo = Object.entries(VOICES).flatMap(([pack, voice]) => all.filter(([line]) => !existsSync(new URL(`tts/${voice}/${line}.mp3`, WORK))).map(([line, text]) => ({ pack, voice, line, text })))
const chars = todo.reduce((n, t) => n + t.text.length, 0)
console.log(`${all.length} lines x ${Object.keys(VOICES).length} voices, ${todo.length} not yet spoken: ${chars} characters`)
if (todo.length > 0 && !process.argv.includes('--yes')) {
  console.log('dry run: add --yes to send')
  process.exit(0)
}
for (const voice of Object.values(VOICES)) mkdirSync(new URL(`tts/${voice}/`, WORK), { recursive: true })
const auth = todo.length > 0 ? key() : null
let next = 0
await Promise.all(Array.from({ length: AT_ONCE }, async () => {
  while (next < todo.length) {
    const t = todo[next++]
    writeFileSync(new URL(`tts/${t.voice}/${t.line}.mp3`, WORK), await speak(auth, t.voice, t.text))
    if (next % 50 === 0) console.log(`  ${next}/${todo.length}`)
  }
}))
for (const [pack, voice] of Object.entries(VOICES)) {
  const dest = new URL(`voices/${pack}/`, WORK)
  mkdirSync(dest, { recursive: true })
  for (const [line] of all) trim(new URL(`tts/${voice}/${line}.mp3`, WORK).pathname, new URL(`${line}.wav`, dest).pathname)
  console.log(`${pack}: ${all.length} lines -> ${dest.pathname}`)
}
