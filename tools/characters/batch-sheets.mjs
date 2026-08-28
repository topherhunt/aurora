// ---------------------------------------------------------------------------
// Batch candidate generation across the characters.json roster. Generates N
// sheet-view candidates per character for one view (front/side/back), saving
// each to tools/characters/sheets/<id>/candidates/<view>-<n>.png plus a
// per-character candidates.json manifest -- for bulk review in gen-sheet.html
// rather than clicking "generate" one character at a time.
//
// THIS SCRIPT SPENDS REAL MONEY (one OpenRouter call per candidate). It is
// never invoked automatically by anything else in this repo -- it only runs
// when a human types the command below, after confirming the printed cost
// estimate. Resumable and per-character-fault-tolerant: a character that
// already has enough candidates (or, for front, is already picked) is
// skipped, and one character's failure is logged and does not abort the rest.
//
// Runs up to --concurrency characters at once (default 10). Parallelism is
// across characters, not within one -- a single character's own candidates
// are still generated one at a time, since they share one candidates.json
// manifest and running two writes to it at once would race.
//
// Usage:
//   node --env-file=.env tools/characters/batch-sheets.mjs front --n=2
//   node --env-file=.env tools/characters/batch-sheets.mjs side --n=1 --concurrency=10
//   node --env-file=.env tools/characters/batch-sheets.mjs back --n=1 --only=blacksmith,farmer
//   node --env-file=.env tools/characters/batch-sheets.mjs front --n=2 --dry-run
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateImage } from './openrouter.mjs'
import { buildViewPrompt } from './sheet-prompt.mjs'
import { describeNordicCharacter } from './nordic-roster.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const VIEWS = ['front', 'side', 'back']
const COST_PER_CALL = 0.015 // FLUX.2 Klein 4B @ 1MP, see openrouter.mjs header

function parseArgs(argv) {
  const [view, ...rest] = argv
  if (!VIEWS.includes(view)) throw new Error(`usage: batch-sheets.mjs <${VIEWS.join('|')}> [--n=2] [--only=id1,id2] [--force] [--dry-run]`)
  const opts = { view, n: 2, only: null, force: false, dryRun: false, concurrency: 10 }
  for (const arg of rest) {
    if (arg === '--force') opts.force = true
    else if (arg === '--dry-run') opts.dryRun = true
    else if (arg.startsWith('--n=')) opts.n = Number(arg.slice(4))
    else if (arg.startsWith('--only=')) opts.only = arg.slice(7).split(',').map((s) => s.trim())
    else if (arg.startsWith('--concurrency=')) opts.concurrency = Number(arg.slice(14))
    else throw new Error(`unknown arg "${arg}"`)
  }
  return opts
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// generateImage occasionally fails with a bare network error ("fetch failed",
// no HTTP status) under concurrent load -- transient, not a content/API
// problem, and it clears up on its own. Retry those a couple of times with a
// short backoff before giving up; a real API error (bad prompt, moderation
// block, quota) carries a status code in the message and is NOT retried, so
// a persistent problem still fails fast instead of burning 3x the calls.
async function generateImageWithRetry(args, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await generateImage(args)
    } catch (e) {
      const transient = !/status \d/.test(e.message)
      if (!transient || i === attempts) throw e
      await sleep(500 * i)
    }
  }
}

function sheetsDir(id) { return resolve(ROOT, 'tools/characters/sheets', id) }
function candidatesDir(id) { return resolve(sheetsDir(id), 'candidates') }
function manifestPath(id) { return resolve(sheetsDir(id), 'candidates.json') }

function loadManifest(id) {
  const p = manifestPath(id)
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { front: [], side: [], back: [] }
}

function saveManifest(id, manifest) {
  mkdirSync(sheetsDir(id), { recursive: true })
  writeFileSync(manifestPath(id), JSON.stringify(manifest, null, 2) + '\n')
}

// Which characters still need work for this view, and how many candidates
// each one needs -- the plan step this batch fulfils.
function plan(characters, { view, n, only, force }) {
  const items = []
  for (const c of characters) {
    if (only && !only.includes(c.id)) continue
    const pickedFile = resolve(sheetsDir(c.id), `${view}.png`)
    if (!force && existsSync(pickedFile)) continue // already picked -- nothing to review
    if (view !== 'front' && !existsSync(resolve(sheetsDir(c.id), 'front.png'))) {
      console.warn(`skip ${c.id}: no picked front.png yet -- ${view} needs it as a reference`)
      continue
    }
    const manifest = loadManifest(c.id)
    const have = force ? 0 : (manifest[view] || []).length
    const need = Math.max(0, n - have)
    if (need > 0) items.push({ character: c, need, have })
  }
  return items
}

// Generates one character's remaining candidates for this view, sequentially
// (they share a manifest file). Never throws -- a failed candidate is logged
// and the rest of this character's candidates, and every other character,
// still proceed.
async function processCharacter(character, need, view, progress) {
  const manifest = loadManifest(character.id)
  let referenceImages
  if (view !== 'front') referenceImages = [readFileSync(resolve(sheetsDir(character.id), 'front.png'))]

  for (let i = 0; i < need; i++) {
    try {
      const vars = describeNordicCharacter({
        role: character.role,
        gender: character.gender,
        age: character.age,
        professionId: character.professionId || undefined,
      })
      const prompt = buildViewPrompt(view, vars)
      const { buffer, cost } = await generateImageWithRetry({ prompt, referenceImages })
      const idx = (manifest[view] || []).length + 1
      const file = `${view}-${idx}.png`
      mkdirSync(candidatesDir(character.id), { recursive: true })
      writeFileSync(resolve(candidatesDir(character.id), file), buffer)
      manifest[view] = [...(manifest[view] || []), { file, cost }]
      saveManifest(character.id, manifest)
      progress.calls += 1
      progress.totalCost += cost
      console.log(`[${progress.calls}/${progress.totalCalls}] ${character.id} ${view} #${idx} -- $${cost.toFixed(4)} (running total $${progress.totalCost.toFixed(2)})`)
    } catch (e) {
      progress.calls += 1
      console.error(`[${progress.calls}/${progress.totalCalls}] ${character.id} ${view} #${i + 1} FAILED: ${e.message}`)
    }
  }
}

// Bounded-concurrency pool: at most `concurrency` characters in flight at
// once, each drawn from the same shared queue as soon as a slot frees up.
async function runPool(items, concurrency, worker) {
  const queue = [...items]
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    let item
    while ((item = queue.shift())) await worker(item)
  })
  await Promise.all(workers)
}

async function run() {
  const opts = parseArgs(process.argv.slice(2))
  const { characters } = JSON.parse(readFileSync(resolve(ROOT, 'tools/characters/characters.json'), 'utf8'))
  const items = plan(characters, opts)
  const totalCalls = items.reduce((sum, it) => sum + it.need, 0)

  console.log(`view=${opts.view} n=${opts.n} concurrency=${opts.concurrency}${opts.only ? ` only=${opts.only.join(',')}` : ''}${opts.force ? ' force' : ''}`)
  console.log(`${items.length} character(s) need candidates, ${totalCalls} call(s), ~$${(totalCalls * COST_PER_CALL).toFixed(2)} estimated`)
  for (const it of items) console.log(`  ${it.character.id}: +${it.need} (have ${it.have})`)

  if (opts.dryRun || totalCalls === 0) { console.log(opts.dryRun ? 'dry run -- no calls made' : 'nothing to do'); return }

  const progress = { calls: 0, totalCost: 0, totalCalls }
  const startedAt = Date.now()

  await runPool(items, opts.concurrency, ({ character, need }) => processCharacter(character, need, opts.view, progress))

  const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(0)
  console.log(`done: ${progress.calls} call(s), $${progress.totalCost.toFixed(2)} total, ${elapsedS}s elapsed`)
}

run().catch((e) => { console.error(e); process.exitCode = 1 })
