// Cut a rhythmic clip into a seamless loop of whole bars, for LoopVoice's `exact` mode (sound-engine.js).
//
//   node tools/music/bar-loop.mjs <in> <out.wav> --period <s> [--fade <ms>]
//
// --period is the loop's length by ear (e.g. two bars); the exact length is found within 10% of it by correlating the
// clip's envelope with itself, then refined on the waveform within 2 ms (the waveform alone can slip a low drum's cycle).
// The loop starts where the clip first sounds and runs that exact length. Its first --fade ms (default 20) are crossfaded
// with the same moment one period later, so the last sample runs straight into the first. Written as mono 16-bit WAV:
// an mp3's encoder delay is trimmed by some decoders and not others, which would move the loop point.

import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = args.indexOf(name)
  if (i < 0) return dflt
  const v = Number(args.splice(i, 2)[1])
  if (!(v > 0)) throw new Error(`${name} must be a positive number`)
  return v
}
const period = flag('--period', null)
const fadeMs = flag('--fade', 20)
const [input, output] = args
if (!input || !output || period === null) throw new Error('usage: bar-loop.mjs <in> <out.wav> --period <s> [--fade <ms>]')

const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate', '-of', 'csv=p=0', input], { encoding: 'utf8' })
if (probe.status !== 0) throw new Error(`ffprobe failed: ${probe.stderr}`)
const sr = Number(probe.stdout.trim())
const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', input, '-ac', '1', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 })
if (dec.status !== 0) throw new Error(`ffmpeg decode failed: ${dec.stderr}`)
const x = new Float32Array(dec.stdout.buffer, dec.stdout.byteOffset, dec.stdout.length / 4)

const corr = (sig, a, n, lag) => {
  let s = 0, ea = 0, eb = 0
  for (let i = 0; i < n; i++) { const p = sig[a + i], q = sig[a + lag + i]; s += p * q; ea += p * p; eb += q * q }
  return s / Math.sqrt(ea * eb)
}
const best = (sig, a, n, lo, hi) => {
  let at = lo, c = -2
  for (let l = lo; l <= hi; l++) { const k = corr(sig, a, n, l); if (k > c) { c = k; at = l } }
  return [at, c]
}

// The envelope: 10 ms RMS every millisecond.
const hop = Math.round(sr / 1000), win = 10 * hop
const env = []
for (let i = 0; i + win <= x.length; i += hop) {
  let s = 0
  for (let j = 0; j < win; j++) s += x[i + j] ** 2
  env.push(Math.sqrt(s / win))
}
const pms = Math.round(period * 1000), hi = Math.round(pms * 1.1)
if (hi + 1 >= env.length) throw new Error(`the clip (${(x.length / sr).toFixed(3)} s) is too short to hold --period ${period} s and match it`)
const [coarse, envCorr] = best(env, 0, env.length - hi - 1, Math.round(pms * 0.9), hi)
const [L, waveCorr] = best(x, 0, Math.round(0.25 * sr), coarse * hop - 2 * hop, coarse * hop + 2 * hop)

let s0 = 0
while (s0 < x.length && Math.abs(x[s0]) < 1e-3) s0++
const F = Math.round((fadeMs / 1000) * sr)
if (s0 + L + F > x.length) throw new Error(`the clip ends ${((s0 + L + F - x.length) / sr * 1000).toFixed(0)} ms short of a period and its crossfade past where it first sounds`)
const out = new Float32Array(L)
for (let i = 0; i < L; i++) out[i] = x[s0 + i]
for (let i = 0; i < F; i++) out[i] = (x[s0 + i] * i) / F + (x[s0 + L + i] * (F - i)) / F

const enc = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(sr), '-ac', '1', '-i', '-', '-c:a', 'pcm_s16le', output], { input: Buffer.from(out.buffer) })
if (enc.status !== 0) throw new Error(`ffmpeg encode failed: ${enc.stderr}`)
console.log(`${output}: ${L} samples at ${sr} Hz = ${(L / sr).toFixed(5)} s from ${(s0 / sr * 1000).toFixed(1)} ms; envelope match ${envCorr.toFixed(3)}, waveform ${waveCorr.toFixed(3)}`)
