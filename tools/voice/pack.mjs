// Packs the baked voices for the game (_notes/conversation-and-quests.md, "Voice"): each voice's lines as one file of
// back-to-back MP3 streams, plus `{ lines: { line: [byteOffset, byteLength, seconds] } }`, so the game fetches a voice
// once and decodes one line only when it plays (audio/voices.js). Writes public/sounds/voice/moments.json too: which
// lines serve each moment, the table talk/lines.js picks from.
//
//   node tools/voice/pack.mjs
//
// Every slice is a whole MP3 stream (its own encode, no ID3), so decodeAudioData takes it alone. MP3 rather than Opus
// because the rest of public/sounds is MP3 and the Quest browser decodes it everywhere.

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { HUMAN, LEAFKIN, MOMENTS } from './atoms.js'

const WORK = new URL('./work/', import.meta.url)
const OUT = new URL('../../public/sounds/voice/', import.meta.url)
const HUMAN_VOICES = ['man', 'woman', 'boy', 'girl']
const KBPS = 48

/** A 16-bit PCM WAV's length in seconds, from its header. */
function wavSeconds(path) {
  const b = readFileSync(path)
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`pack: ${path} is not a WAV`)
  let at = 12, rate = 0, bytesPerFrame = 0
  while (at + 8 <= b.length) {
    const id = b.toString('ascii', at, at + 4)
    const size = b.readUInt32LE(at + 4)
    if (id === 'fmt ') { rate = b.readUInt32LE(at + 12); bytesPerFrame = b.readUInt16LE(at + 20) }
    if (id === 'data') return size / bytesPerFrame / rate
    at += 8 + size + (size & 1)
  }
  throw new Error(`pack: ${path} has no data chunk`)
}

const encode = (path) => execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-c:a', 'libmp3lame', '-b:a', `${KBPS}k`, '-id3v2_version', '0', '-write_id3v1', '0', '-f', 'mp3', '-'], { maxBuffer: 1 << 26 })

function pack(name, files) {
  const parts = []
  const lines = {}
  let off = 0
  for (const [line, path] of files) {
    const mp3 = encode(path)
    lines[line] = [off, mp3.length, Math.round(wavSeconds(path) * 1000) / 1000]
    parts.push(mp3)
    off += mp3.length
  }
  writeFileSync(new URL(`${name}.mp3`, OUT), Buffer.concat(parts))
  writeFileSync(new URL(`${name}.json`, OUT), JSON.stringify({ lines }))
  console.log(`${name}: ${files.length} lines, ${(off / 1024).toFixed(0)} KB`)
  return new Set(Object.keys(lines))
}

mkdirSync(OUT, { recursive: true })

// Human voices: `<utterance>.<variant>.wav`, variant `r<reading>` or `r<reading>-<form>`.
let shared = null
for (const voice of HUMAN_VOICES) {
  const dir = new URL(`voices/${voice}/`, WORK)
  const files = readdirSync(dir).filter((f) => f.endsWith('.wav')).sort().map((f) => [f.slice(0, -4), new URL(f, dir)])
  const have = pack(voice, files)
  shared = shared === null ? have : new Set([...shared].filter((l) => have.has(l)))
}

// Leafkin: the raw leafkin takes, `lk.<atom>.<tier>-<n>.leafkin.wav`, sped up at playback.
const lkFiles = readdirSync(WORK).filter((f) => /^lk\..+\.leafkin\.wav$/.test(f)).sort().map((f) => [f.slice(0, -'.leafkin.wav'.length), new URL(f, WORK)])
const lkHave = pack('leafkin', lkFiles)

// Moments: a human moment lists `utterance.rN` for a line every voice has, or `utterance.rN-{a|b}` for a line recorded
// in forms, each form present in every voice. A form missing from any voice drops that reading from its moments.
const human = {}
for (const k of Object.keys(MOMENTS)) human[k] = []
for (const ut of HUMAN) {
  const forms = /\{([^}]+)\}/.exec(ut.text)?.[1].split('|').map((f) => f.replace(/'s$/, '').toLowerCase())
  ut.reads.forEach((read, i) => {
    const base = `${ut.id}.r${i + 1}`
    const ok = forms === undefined ? shared.has(base) : forms.every((f) => shared.has(`${base}-${f}`))
    if (!ok) return
    const line = forms === undefined ? base : `${base}-{${forms.join('|')}}`
    for (const m of read.uses) {
      if (human[m] === undefined) throw new Error(`pack: ${ut.id} serves unknown moment ${m}`)
      human[m].push(line)
    }
  })
}
// Leafkin: atom -> tier -> lines.
const leafkin = {}
for (const atom of LEAFKIN) {
  leafkin[atom.id] = {}
  for (const tier of Object.keys(atom.tiers)) leafkin[atom.id][tier] = atom.tiers[tier].map((_, i) => `${atom.id}.${tier}-${i + 1}`).filter((l) => lkHave.has(l))
}
writeFileSync(new URL('moments.json', OUT), JSON.stringify({ human, leafkin }))
const empty = Object.entries(human).filter(([, v]) => v.length === 0).map(([k]) => k)
console.log(`moments.json: ${Object.keys(human).length} human moments${empty.length ? `, ${empty.length} with no line yet (${empty.join(', ')})` : ''}`)
if (!existsSync(new URL('leafkin.mp3', OUT))) throw new Error('pack: no leafkin pack written')
