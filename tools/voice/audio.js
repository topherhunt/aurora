// Pure sample work for voice-recorder.html: trim, normalise, encode. No DOM, so a node script can check it.

export const TRIM = {
  // Dropped from both ends before anything else: the click of the key that started and stopped the take.
  keyClickS: 0.15,
  // A 10 ms window louder than this RMS is voice (about -46 dBFS).
  gate: 0.005,
  win: 0.01,
  // Kept around the voice so breaths in and tails out survive.
  padInS: 0.06,
  padOutS: 0.15,
  fadeS: 0.005,
  peak: 0.89, // -1 dBFS
}

/** `samples` with key clicks cut, silence trimmed, edges faded and peak normalised; null when nothing passed the gate. */
export function cleanTake(samples, rate) {
  const click = Math.round(TRIM.keyClickS * rate)
  const body = samples.subarray(click, Math.max(click, samples.length - click))
  const win = Math.round(TRIM.win * rate)
  let first = -1
  let last = -1
  for (let i = 0; i + win <= body.length; i += win) {
    let sum = 0
    for (let j = i; j < i + win; j++) sum += body[j] * body[j]
    if (Math.sqrt(sum / win) < TRIM.gate) continue
    if (first < 0) first = i
    last = i + win
  }
  if (first < 0) return null
  const from = Math.max(0, first - Math.round(TRIM.padInS * rate))
  const to = Math.min(body.length, last + Math.round(TRIM.padOutS * rate))
  const out = body.slice(from, to)
  let peak = 0
  for (const v of out) peak = Math.max(peak, Math.abs(v))
  const gain = TRIM.peak / peak
  const fade = Math.min(Math.round(TRIM.fadeS * rate), out.length >> 1)
  for (let i = 0; i < out.length; i++) {
    const edge = Math.min(1, i / fade, (out.length - 1 - i) / fade)
    out[i] *= gain * edge
  }
  return out
}

/** Mono float samples as a 16-bit PCM WAV. */
export function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2)
  const v = new DataView(buf)
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE')
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  str(36, 'data'); v.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true)
  return buf
}

/** `samples` resampled by `semitones` (linear): pitch and length move together, as a faster playback would. */
export function shiftPitch(samples, semitones) {
  if (semitones === 0) return samples
  const step = 2 ** (semitones / 12)
  const out = new Float32Array(Math.floor((samples.length - 1) / step))
  for (let i = 0; i < out.length; i++) {
    const x = i * step
    const j = Math.floor(x)
    out[i] = samples[j] + (samples[j + 1] - samples[j]) * (x - j)
  }
  return out
}

/** Segments joined end to end: `gapS` > 0 puts silence between, < 0 overlaps them by that much with an equal-power crossfade. */
export function join(segments, rate, gapS) {
  const parts = segments.filter((s) => s.length > 0).map((s) => s.slice())
  const edge = Math.round(TRIM.fadeS * rate)
  for (const p of parts) {
    const n = Math.min(edge, p.length >> 1)
    for (let i = 0; i < n; i++) { p[i] *= i / n; p[p.length - 1 - i] *= i / n }
  }
  const gap = Math.round(gapS * rate)
  let total = 0
  for (const [i, p] of parts.entries()) total += p.length + (i > 0 ? gap : 0)
  const out = new Float32Array(Math.max(0, total))
  let at = 0
  for (const [i, p] of parts.entries()) {
    if (i > 0) at += gap
    const lap = i > 0 && gap < 0 ? Math.min(-gap, p.length, at) : 0
    for (let j = 0; j < p.length; j++) {
      if (j < lap) {
        const t = j / lap
        out[at + j] = out[at + j] * Math.cos(t * Math.PI / 2) + p[j] * Math.sin(t * Math.PI / 2)
      } else out[at + j] = p[j]
    }
    at += p.length
  }
  return out
}

/** One file per (utterance, variant, take): `back-again.r2.base.wav`, `where-could-be.r1-she.light.wav`. */
export const fileName = (id, variant, take) => `${id}.${variant}.${take}.wav`
