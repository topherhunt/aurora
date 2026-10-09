// Bake the far cards into dist/cards.bin for the build in dist (see props/card-cache.js).
// Serves dist with `vite preview`, boots it with ?bakecards in headless Chrome on
// the real GPU, waits until no new card has been photographed for SETTLE_MS, and
// writes what the page recorded. devops/deploy.sh runs it right after the build.
//
//   node scripts/bake-cards.mjs

import { spawn } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const PREVIEW_PORT = 4179
const CDP_PORT = 9361
const SETTLE_MS = 5000
const DEADLINE_MS = 120000
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PROFILE = '/tmp/aurora-bake-cards-profile'
const OUT = resolve(ROOT, 'dist/cards.bin')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
if (!existsSync(resolve(ROOT, 'dist/index.html'))) throw new Error('bake-cards: no dist/index.html; run `npm run build` first')
rmSync(OUT, { force: true })
rmSync(PROFILE, { recursive: true, force: true })

// Both children die with this script; Chrome also under a perl alarm, which outlives even a SIGKILLed driver.
const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
const chrome = spawn('/usr/bin/perl', ['-e', 'alarm shift; exec @ARGV', String(DEADLINE_MS / 1000 + 60), CHROME,
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
  '--ignore-certificate-errors', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
  '--window-size=1200,800', 'about:blank'], { stdio: 'ignore' })
let previewLog = ''
preview.stdout.on('data', (b) => { previewLog += b })
preview.stderr.on('data', (b) => { previewLog += b })
process.on('exit', () => { preview.kill(); chrome.kill() })
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130))

async function poll(what, fn, ms = 30000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn().catch(() => null)
    if (v) return v
    await sleep(250)
  }
  throw new Error(`bake-cards: timed out waiting for ${what}${what === 'vite preview' ? `\n${previewLog}` : ''}`)
}

const origin = `https://localhost:${PREVIEW_PORT}`
await poll('vite preview', () => new Promise((res) => {
  // basic-ssl's certificate is self-signed, so the probe goes over plain TCP and only asks that the port answers.
  import('node:net').then(({ connect }) => {
    const s = connect(PREVIEW_PORT, '127.0.0.1', () => { s.end(); res(true) })
    s.on('error', () => res(false))
  })
}))
const page = await poll('Chrome', async () => (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((t) => t.type === 'page'))

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const pending = new Map()
const errors = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)
  if (!m.id || !pending.has(m.id)) return
  const p = pending.get(m.id)
  pending.delete(m.id)
  if (m.error) p.rej(new Error(JSON.stringify(m.error)))
  else p.res(m.result)
}
const send = (method, params = {}) => new Promise((res, rej) => {
  const n = ++id
  pending.set(n, { res, rej })
  ws.send(JSON.stringify({ id: n, method, params }))
})
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(`bake-cards: page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
  return r.result.value
}

await send('Runtime.enable')
await send('Page.enable')
await send('Page.navigate', { url: `${origin}/?bakecards` })

const t0 = Date.now()
let last = -1
let lastChange = Date.now()
for (;;) {
  if (errors.length) throw new Error(`bake-cards: the page threw during boot:\n${errors.join('\n')}`)
  const s = await evaluate(`window.__cards ? { ...window.__cards.stats(), booted: document.getElementById('boot').classList.contains('gone') } : null`)
  if (s && s.recorded !== last) {
    last = s.recorded
    lastChange = Date.now()
  }
  if (s?.booted && Date.now() - lastChange > SETTLE_MS) break
  if (Date.now() - t0 > DEADLINE_MS) throw new Error(`bake-cards: the boot did not settle in ${DEADLINE_MS / 1000} s (last stats ${JSON.stringify(s)})`)
  await sleep(500)
}
if (last === 0) throw new Error('bake-cards: the boot photographed no cards')

const b64 = await evaluate(`(async () => {
  const gz = await new Response(new Blob([window.__cards.pack()]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
  const bytes = new Uint8Array(gz)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
})()`)
const buf = Buffer.from(b64, 'base64')
writeFileSync(OUT, buf)
console.log(`bake-cards: ${last} cards, ${(buf.length / 2 ** 20).toFixed(1)} MB gzipped -> dist/cards.bin (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
ws.close()
process.exit(0)
