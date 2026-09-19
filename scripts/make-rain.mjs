// Bakes public/sounds/weather-rain-1.mp3: a seamless rain loop the ambience
// holds under `precip` (§10, audio/ambience.js RULES.rain). Synthesised, since
// the sound library has no rain: a low hiss from filtered noise, a bed of
// rumble under it, and the pitter-patter on top -- three tiers of drop, each a
// damped sine with a click at its onset, from the tick of a drop on a leaf to
// the plop of one into a puddle -- mono, looped by a crossfade of the tail
// into the head.
//
//   node scripts/make-rain.mjs        (needs ffmpeg on PATH for the mp3)
//
// The WAV is written to the scratch directory and encoded from there.

import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const RATE = 32000
const SECONDS = 12
const FADE = 1.5 // s of crossfade at the seam
const OUT = 'public/sounds/weather-rain-1.mp3'

let h = 0x2545f491
const rnd = () => { h = (Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0); h = (Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0); return ((h ^ (h >>> 15)) >>> 0) / 4294967296 }
const gauss = () => { const u = rnd() || 1e-9, v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) }

const n = Math.floor((SECONDS + FADE) * RATE)
const out = new Float32Array(n)

// The hiss: white noise through a one-pole high-pass then two one-pole
// low-passes, so the band is roughly 300 Hz to 2.5 kHz and falls away above --
// the wash of rain on ground heard through the drops, not a treble sizzle over
// them -- with a slow wander in level so it gusts rather than sitting at one loudness.
let hp = 0, lp = 0, lp2 = 0, prev = 0, wander = 0
const aHp = Math.exp(-2 * Math.PI * 300 / RATE), aLp = Math.exp(-2 * Math.PI * 2500 / RATE)
for (let i = 0; i < n; i++) {
  const w = gauss()
  hp = aHp * (hp + w - prev); prev = w
  lp += (1 - aLp) * (hp - lp)
  lp2 += (1 - aLp) * (lp - lp2)
  if (i % 512 === 0) wander += (gauss() * 0.08 - wander * 0.05)
  out[i] += lp2 * 0.16 * (1 + Math.max(-0.5, Math.min(0.5, wander)))
}

// The rumble: the same noise far lower, for the body of a downpour.
let r1 = 0, r2 = 0
const aR = Math.exp(-2 * Math.PI * 180 / RATE)
for (let i = 0; i < n; i++) {
  r1 += (1 - aR) * (gauss() - r1)
  r2 += (1 - aR) * (r1 - r2)
  out[i] += r2 * 0.6
}

// The drops. Each is a damped sine whose pitch falls a little over its ring,
// with a broadband click on the onset; the three tiers are the ticks of drops
// on leaves, the taps of drops on stone, and the odd plop into a puddle. The
// tiers are sparse enough to hear as separate drops -- a few hundred a second
// smears back into hiss.
const TIERS = [
  { perS: 90, f: [1800, 4200], ring: [0.006, 0.018], amp: [0.06, 0.22], click: 0.5 },
  { perS: 40, f: [700, 1600], ring: [0.012, 0.035], amp: [0.10, 0.35], click: 0.3 },
  { perS: 8, f: [260, 520], ring: [0.03, 0.07], amp: [0.18, 0.5], click: 0.15 },
]
const DROPS_PER_S = TIERS.reduce((a, t) => a + t.perS, 0)
const between = ([lo, hi]) => lo + rnd() * (hi - lo)
for (const t of TIERS) {
  for (let k = 0; k < t.perS * (SECONDS + FADE); k++) {
    const at = Math.floor(rnd() * n)
    const ring = between(t.ring), f0 = between(t.f), amp = t.amp[0] + rnd() * rnd() * (t.amp[1] - t.amp[0])
    const len = Math.floor(RATE * ring * 4)
    const clickLen = Math.floor(RATE * 0.0012)
    let phase = rnd() * Math.PI * 2
    for (let j = 0; j < len && at + j < n; j++) {
      const s = j / RATE
      const env = Math.exp(-s / ring) * Math.min(1, j / (RATE * 0.0008))
      const f = f0 * (1 - 0.25 * (1 - Math.exp(-s / ring)))
      phase += (2 * Math.PI * f) / RATE
      const click = j < clickLen ? gauss() * t.click * (1 - j / clickLen) : 0
      out[at + j] += (Math.sin(phase) * env + click) * amp
    }
  }
}

// The seam: the last FADE seconds fold onto the first, equal-power.
const F = Math.floor(FADE * RATE), body = n - F
const loop = new Float32Array(body)
for (let i = 0; i < body; i++) {
  if (i < F) {
    const t = i / F
    loop[i] = out[i] * Math.sin((t * Math.PI) / 2) + out[body + i] * Math.cos((t * Math.PI) / 2)
  } else loop[i] = out[i]
}

// Normalise to -12 dBFS peak, where the library's loops sit, and write 16-bit mono PCM.
let peak = 0
for (const v of loop) peak = Math.max(peak, Math.abs(v))
const scale = 0.25 / peak
const wav = Buffer.alloc(44 + body * 2)
wav.write('RIFF', 0); wav.writeUInt32LE(36 + body * 2, 4); wav.write('WAVE', 8)
wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(RATE, 24); wav.writeUInt32LE(RATE * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
wav.write('data', 36); wav.writeUInt32LE(body * 2, 40)
for (let i = 0; i < body; i++) wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, loop[i] * scale)) * 32767), 44 + i * 2)

const dir = mkdtempSync(join(tmpdir(), 'rain-'))
const wavPath = join(dir, 'rain.wav')
writeFileSync(wavPath, wav)
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wavPath, '-codec:a', 'libmp3lame', '-b:a', '96k', OUT])
console.log(`${OUT}: ${SECONDS} s mono at ${RATE} Hz, ${DROPS_PER_S} drops/s, peak ${(20 * Math.log10(0.25)).toFixed(1)} dBFS`)
