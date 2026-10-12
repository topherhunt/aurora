// Node-side gates for the baked voice packs (public/sounds/voice/, tools/voice/pack.mjs; audio/voices.js slices them).
//
//   node scripts/check-voice.mjs
//
// Each pack's index tiles its MP3 exactly, every slice opens on an MP3 frame header (a slice that does not is a line
// decodeAudioData refuses, silently, at the moment someone should speak), and every line moments.json names is in
// every pack that speaks it. What this can NOT check: how the lines sound.

import { readFileSync } from 'node:fs'
import { bodyVoice } from '../src/v2/talk/mind.js'
import { TOWNSFOLK } from '../src/v2/render/townsfolk.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

const dir = new URL('../public/sounds/voice/', import.meta.url)
const table = JSON.parse(readFileSync(new URL('moments.json', dir), 'utf8'))
const humanPacks = [...new Set(TOWNSFOLK.bodies.map((b) => bodyVoice(b).pack))]
const packs = new Map([...humanPacks, 'leafkin'].map((name) => [name, { lines: JSON.parse(readFileSync(new URL(`${name}.json`, dir), 'utf8')).lines, bytes: readFileSync(new URL(`${name}.mp3`, dir)) }]))

for (const [name, { lines, bytes }] of packs) {
  const slices = Object.entries(lines).sort((a, b) => a[1][0] - b[1][0])
  let end = 0
  const gaps = slices.filter(([, [at, len]]) => { const bad = at !== end || len <= 0; end = at + len; return bad }).map(([l]) => l)
  check(gaps.length === 0 && end === bytes.length, `${name}: the index tiles the MP3 end to end, no gap or overlap`, gaps.length ? gaps.slice(0, 5).join(', ') : `${end} of ${bytes.length} bytes`)
  const unsynced = slices.filter(([, [at]]) => !(bytes[at] === 0xff && (bytes[at + 1] & 0xe0) === 0xe0)).map(([l]) => l)
  check(unsynced.length === 0, `${name}: every line opens on an MP3 frame header`, unsynced.slice(0, 5).join(', '))
  const durs = slices.filter(([, l]) => !(l[2] > 0.1 && l[2] < 15)).map(([l]) => l)
  check(durs.length === 0, `${name}: every line runs a plausible length`, durs.slice(0, 5).join(', '))
}

// A `{he|she}` line is recorded once per form.
const expand = (line) => {
  const forms = /\{([^}]+)\}$/.exec(line)
  return forms === null ? [line] : forms[1].split('|').map((f) => line.replace(/\{[^}]+\}$/, f))
}
for (const name of humanPacks) {
  const missing = Object.entries(table.human).flatMap(([m, ls]) => ls.flatMap(expand).filter((l) => packs.get(name).lines[l] === undefined).map((l) => `${m}:${l}`))
  check(missing.length === 0, `${name}: every human moment's lines are in the pack`, missing.slice(0, 5).join(', '))
}
const lkMissing = Object.entries(table.leafkin).flatMap(([atom, tiers]) => Object.values(tiers).flat().filter((l) => packs.get('leafkin').lines[l] === undefined).map((l) => `${atom}:${l}`))
check(lkMissing.length === 0, 'leafkin: every atom\'s lines are in the pack', lkMissing.slice(0, 5).join(', '))
const empty = [...Object.entries(table.human).filter(([, ls]) => ls.length === 0).map(([m]) => m), ...Object.entries(table.leafkin).filter(([, t]) => Object.values(t).every((ls) => ls.length === 0)).map(([a]) => `lk.${a}`)]
check(empty.length === 0, 'every moment has at least one line', empty.join(', '))

console.log(failures === 0 ? '\nall voice checks pass' : `\n${failures} voice check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
