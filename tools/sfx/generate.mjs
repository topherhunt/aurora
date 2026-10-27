#!/usr/bin/env node
// Generates the sound effects in tools/sfx/manifest.json through ElevenLabs sound-generation, then trims and loudness-normalises each into public/sounds/<id>.mp3 (ffmpeg). A file already in tools/sfx/work is never re-fetched. Every charge is appended to tools/sfx/spend.jsonl before the audio is written.
//
// Usage: node tools/sfx/generate.mjs [--dry]   (--dry estimates credits and makes no API calls)

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WORK = resolve(ROOT, 'tools/sfx/work')
const SPEND = resolve(ROOT, 'tools/sfx/spend.jsonl')
const CREDITS_PER_SECOND = 10
const SUFFIX = "Close-mic'd, isolated, no background, no music."
const FILTER = 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.03,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse,loudnorm=I=-16:TP=-1.5:LRA=11'

const jobs = JSON.parse(readFileSync(resolve(ROOT, 'tools/sfx/manifest.json'), 'utf8'))
const missing = jobs.filter((j) => !existsSync(resolve(WORK, `${j.id}.mp3`)))
console.log(`${missing.length} of ${jobs.length} to generate, ~${missing.reduce((s, j) => s + j.seconds * CREDITS_PER_SECOND, 0)} credits`)
if (process.argv.includes('--dry')) process.exit(0)

const key = readFileSync(resolve(ROOT, '.env'), 'utf8').match(/^ELEVENLABS_API_KEY=(.+)$/m)
if (!key) throw new Error('ELEVENLABS_API_KEY missing from .env')
mkdirSync(WORK, { recursive: true })

for (const j of missing) {
  const res = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
    method: 'POST',
    headers: { 'xi-api-key': key[1].trim().replace(/^["']|["']$/g, ''), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `${j.prompt}. ${SUFFIX}`, duration_seconds: j.seconds, prompt_influence: 0.5 }),
  })
  if (!res.ok) throw new Error(`${j.id}: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const credits = Number(res.headers.get('character-cost'))
  if (!Number.isFinite(credits)) throw new Error('character-cost header missing')
  appendFileSync(SPEND, JSON.stringify({ id: j.id, credits, at: new Date().toISOString() }) + '\n')
  writeFileSync(resolve(WORK, `${j.id}.mp3`), Buffer.from(await res.arrayBuffer()))
  console.log(`ok ${j.id} ${credits} credits`)
}

for (const j of jobs) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', resolve(WORK, `${j.id}.mp3`), '-af', FILTER, '-ac', '1', '-b:a', '64k', resolve(ROOT, `public/sounds/${j.id}.mp3`)])
}
console.log(`wrote ${jobs.length} to public/sounds/`)
