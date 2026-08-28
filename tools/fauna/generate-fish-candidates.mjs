// ---------------------------------------------------------------------------
// Batch candidate generation across the fish SPECIES roster (fish-roster.mjs).
// Generates N sideview candidates per species, saving each to
// tools/fauna/sheets/<id>/candidates/side-<n>.png plus a per-species
// candidates.json manifest -- for review in gen-fish.html.
//
// THIS SCRIPT SPENDS REAL MONEY (one OpenRouter call per candidate). It is
// never invoked automatically by anything else in this repo -- it only runs
// when a human types the command below, after confirming the printed cost
// estimate. One species's failure is logged and does not abort the rest.
//
// Usage:
//   node --env-file=.env tools/fauna/generate-fish-candidates.mjs --n=1
//   node --env-file=.env tools/fauna/generate-fish-candidates.mjs --n=2 --only=ironscale-bass
//   node --env-file=.env tools/fauna/generate-fish-candidates.mjs --n=1 --dry-run
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateImage } from '../characters/openrouter.mjs'
import { buildFishPrompt } from './fish-prompt.mjs'
import { SPECIES } from './fish-roster.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const COST_PER_CALL = 0.015 // FLUX.2 Klein 4B @ 1MP, see tools/characters/openrouter.mjs header

function parseArgs(argv) {
  const opts = { n: 1, only: null, force: false, dryRun: false }
  for (const arg of argv) {
    if (arg === '--force') opts.force = true
    else if (arg === '--dry-run') opts.dryRun = true
    else if (arg.startsWith('--n=')) opts.n = Number(arg.slice(4))
    else if (arg.startsWith('--only=')) opts.only = arg.slice(7).split(',').map((s) => s.trim())
    else throw new Error(`unknown arg "${arg}"`)
  }
  return opts
}

function sheetsDir(id) { return resolve(ROOT, 'tools/fauna/sheets', id) }
function candidatesDir(id) { return resolve(sheetsDir(id), 'candidates') }
function manifestPath(id) { return resolve(sheetsDir(id), 'candidates.json') }

function loadManifest(id) {
  const p = manifestPath(id)
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { side: [] }
}

function saveManifest(id, manifest) {
  mkdirSync(sheetsDir(id), { recursive: true })
  writeFileSync(manifestPath(id), JSON.stringify(manifest, null, 2) + '\n')
}

function plan(species, { n, only, force }) {
  const items = []
  for (const s of species) {
    if (only && !only.includes(s.id)) continue
    const pickedFile = resolve(sheetsDir(s.id), 'side.png')
    if (!force && existsSync(pickedFile)) continue
    const manifest = loadManifest(s.id)
    const have = force ? 0 : (manifest.side || []).length
    const need = Math.max(0, n - have)
    if (need > 0) items.push({ species: s, need, have })
  }
  return items
}

async function processSpecies(species, need, progress) {
  const manifest = loadManifest(species.id)
  for (let i = 0; i < need; i++) {
    try {
      const prompt = buildFishPrompt(species.description)
      const { buffer, cost } = await generateImage({ prompt, aspectRatio: '16:9' })
      const idx = (manifest.side || []).length + 1
      const file = `side-${idx}.png`
      mkdirSync(candidatesDir(species.id), { recursive: true })
      writeFileSync(resolve(candidatesDir(species.id), file), buffer)
      manifest.side = [...(manifest.side || []), { file, cost }]
      saveManifest(species.id, manifest)
      progress.calls += 1
      progress.totalCost += cost
      console.log(`[${progress.calls}/${progress.totalCalls}] ${species.id} side #${idx} -- $${cost.toFixed(4)} (running total $${progress.totalCost.toFixed(2)})`)
    } catch (e) {
      progress.calls += 1
      console.error(`[${progress.calls}/${progress.totalCalls}] ${species.id} side #${i + 1} FAILED: ${e.message}`)
    }
  }
}

async function run() {
  const opts = parseArgs(process.argv.slice(2))
  const items = plan(SPECIES, opts)
  const totalCalls = items.reduce((sum, it) => sum + it.need, 0)

  console.log(`n=${opts.n}${opts.only ? ` only=${opts.only.join(',')}` : ''}${opts.force ? ' force' : ''}`)
  console.log(`${items.length} species need candidates, ${totalCalls} call(s), ~$${(totalCalls * COST_PER_CALL).toFixed(2)} estimated`)
  for (const it of items) console.log(`  ${it.species.id}: +${it.need} (have ${it.have})`)

  if (opts.dryRun || totalCalls === 0) { console.log(opts.dryRun ? 'dry run -- no calls made' : 'nothing to do'); return }

  const progress = { calls: 0, totalCost: 0, totalCalls }
  for (const it of items) await processSpecies(it.species, it.need, progress)

  console.log(`done: ${progress.calls} call(s), $${progress.totalCost.toFixed(2)} total`)
}

run().catch((e) => { console.error(e); process.exitCode = 1 })
