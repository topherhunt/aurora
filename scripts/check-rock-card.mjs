// A far boulder's card, checked against the mesh it replaces: one rock drawn
// both ways under the same light and the same eye (rock-card-probe.html), the
// two pictures' mean colour, mean brightness and covered ground compared.
//
// The card is photographed UNLIT and lit live as the mean of a sphere
// (SPHERE_CARD_LIGHT, material.js), and stood in its own instance matrix
// (RockBed._placeTier, spunCardFrame). Neither can be checked without a
// renderer, so this gate drives the page in headless Chrome over the DevTools
// protocol and reads the JSON it writes into #out. A page that never finishes
// fails; a machine with no Chrome SKIPS loudly, as check-shaders does without
// glslang.
//
// Usage: node scripts/check-rock-card.mjs [--shot out.png]   (--shot also saves the page as a person sees it)

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const ROOT = new URL('..', import.meta.url).pathname
const PORT = 5213
const PAGE = '/rock-card-probe.html'
const PAGE_URL = `https://localhost:${PORT}${PAGE}`
const TIMEOUT_MS = 240000
const SHOT = process.argv.includes('--shot') ? process.argv[process.argv.indexOf('--shot') + 1] : null

// Brightness and colour within a tenth; ground covered within a fifth over the
// bed and within half again, either way, on any one rock. The sphere mean is
// exact for a sphere and the boulder is not one, and the card is the mean
// silhouette squeezed from the widest photograph -- see THE CARD in
// rock-bank.js -- so a mesh seen broadside covers more than its card and one
// seen end-on less, and only the bed's mean is the card's to match. On the
// hill the ground cuts the card along a line and the rock around its bulge,
// and the two part most where the eye looks square into the slope: a sunk
// roll draws a card up to half again the rock's height on screen, a third of
// what a box-shaped frame drew a leaned rock at. A rock the hill leaves a
// sliver of, under a third of what one on the flat covers, may swap to a
// sliver or to nothing, never to a whole card, and never the other way round.
const LUMA_TOL = 0.10
const CHROMA_TOL = 0.04
const COVER_TOL = 0.20
const COVER_ONE = 1.5 * 1.5
const SLIVER = 1 / 3

const chrome = findChrome()
if (!chrome) {
  console.log('SKIP  check-rock-card: no headless Chrome (playwright chromium_headless_shell or Google Chrome)')
  process.exit(0)
}

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const profile = mkdtempSync(join(tmpdir(), 'rock-card-'))
const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore', detached: true })
let browser = null
let report = null
let failed = null
try {
  await waitFor(() => fetch(PAGE_URL).then((x) => x.ok).catch(() => false), 60000, `vite to serve ${PAGE_URL}`)
  browser = spawn(chrome, [
    '--headless', '--no-sandbox', '--disable-gpu-sandbox',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-certificate-errors', '--allow-insecure-localhost', '--no-first-run',
    '--disable-background-networking', '--disable-component-update',
    '--window-size=2048,2700',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    PAGE_URL,
  ], { stdio: 'ignore' })
  // Port 0 lets Chrome pick a free one and write it here, so two of these
  // running at once (several sessions share this repo) never collide.
  const portFile = join(profile, 'DevToolsActivePort')
  const cdpPort = await waitFor(() => existsSync(portFile) && Number(readFileSync(portFile, 'utf8').split('\n')[0]), 30000, 'Chrome to open its DevTools port')
  const target = await waitFor(async () => {
    const list = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((r) => r.json()).catch(() => [])
    return list.find((t) => t.type === 'page' && t.url.startsWith(PAGE_URL)) || null
  }, 30000, `${PAGE} to appear as a CDP target`)
  const cdp = await connect(target.webSocketDebuggerUrl)
  const deadline = Date.now() + TIMEOUT_MS
  let state = 'running'
  while (state !== 'done' && state !== 'error') {
    if (Date.now() > deadline) throw new Error(`the probe was still running after ${TIMEOUT_MS / 1000} s`)
    await sleep(1000)
    state = await cdp.eval('window.PROBE_STATE')
  }
  const text = await cdp.eval('document.getElementById("out").textContent')
  if (SHOT) writeFileSync(SHOT, Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  cdp.close()
  if (state === 'error') throw new Error(`the probe page threw: ${text}`)
  report = JSON.parse(text)
} catch (err) {
  failed = err
} finally {
  if (browser) browser.kill('SIGKILL')
  try { process.kill(-vite.pid, 'SIGKILL') } catch { /* already gone */ }
  // Chrome is still writing its profile as it dies.
  await sleep(500)
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
if (failed) {
  console.log(` FAIL  check-rock-card: ${failed.message}`)
  process.exit(1)
}

console.log(`rock card probe on ${report.renderer}`)
console.log(`boulder ${report.measured.width.toFixed(2)} x ${report.measured.height.toFixed(2)} x ${report.measured.depth.toFixed(2)} m, plan mean ${report.measured.planMean.toFixed(2)} m`)
check(report.baked.some((b) => b.name === 'boulder'), 'the boulder card was photographed')

for (const row of report.rows) {
  const { mesh, card } = row
  const luma = card.luma / mesh.luma
  // Chroma as the channel's share of the whole, so a brightness miss is not
  // counted twice.
  const share = (c) => [c.r, c.g, c.b].map((v) => v / (c.r + c.g + c.b))
  const [mr, , mb] = share(mesh)
  const [cr, , cb] = share(card)
  const chroma = Math.max(Math.abs(cr - mr), Math.abs(cb - mb))
  const cover = card.pixels / mesh.pixels
  const tag = `sun ${row.sun}`
  check(Math.abs(luma - 1) <= LUMA_TOL,
    `${tag}: the card is as bright as the mesh`,
    `card/mesh luma ${luma.toFixed(3)} (mesh ${mesh.luma.toFixed(3)}, card ${card.luma.toFixed(3)}), want within ${LUMA_TOL}`)
  check(chroma <= CHROMA_TOL,
    `${tag}: and the same colour`,
    `worst channel share off by ${chroma.toFixed(3)}, want within ${CHROMA_TOL}`)
  check(Math.abs(cover - 1) <= COVER_TOL,
    `${tag}: and covers the ground the mesh covers`,
    `card/mesh pixels ${cover.toFixed(3)} (${card.pixels} / ${mesh.pixels}), want within ${COVER_TOL}`)
  if (mesh.each) {
    const flat = report.placements.map((p, i) => i).filter((i) => !report.placements[i].includes('hill'))
    const sliver = flat.reduce((sum, i) => sum + mesh.each[i], 0) / flat.length * SLIVER
    const shown = mesh.each.map((m, i) => m >= sliver && card.each[i] >= sliver)
    const ratios = mesh.each.map((m, i) => shown[i] ? card.each[i] / m : 1)
    const worst = ratios.reduce((w, r, i) => Math.abs(Math.log(r)) > Math.abs(Math.log(ratios[w])) ? i : w, 0)
    check(ratios.every((r) => r <= COVER_ONE && r >= 1 / COVER_ONE),
      `${tag}: on every roll and lean the bed can place`,
      `card/mesh ${Math.min(...ratios).toFixed(2)} .. ${Math.max(...ratios).toFixed(2)} over ${shown.filter(Boolean).length} rocks showing, worst ${report.placements[worst]}, want each within ${COVER_ONE}x`)
    const half = mesh.each.map((m, i) => !shown[i] && (m >= sliver || card.each[i] >= sliver) ? i : -1).filter((i) => i >= 0)
    check(half.length === 0,
      `${tag}: and a rock the hill leaves a sliver of swaps to a sliver or nothing, and never the other way round`,
      half.length ? half.map((i) => `${report.placements[i]}: mesh ${mesh.each[i]} card ${card.each[i]} px`).join('; ') : `${shown.filter((x) => !x).length} slivers, under ${sliver.toFixed(0)} px`)
  }
}

console.log(`\n${failures === 0 ? 'all rock card checks passed' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)

// ---------------------------------------------------------------------------

function findChrome() {
  const cache = join(homedir(), 'Library/Caches/ms-playwright')
  if (existsSync(cache)) {
    const shells = readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse()
    for (const d of shells) {
      for (const arch of ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64', 'chrome-headless-shell-linux64']) {
        const bin = join(cache, d, arch, 'chrome-headless-shell')
        if (existsSync(bin)) return bin
      }
    }
  }
  const app = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  return existsSync(app) ? app : null
}

async function waitFor(fn, ms, what) {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(300)
  }
}

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url)
    let id = 0
    const waiting = new Map()
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id !== undefined && waiting.has(msg.id)) {
        const { resolve: r, reject: j } = waiting.get(msg.id)
        waiting.delete(msg.id)
        if (msg.error) j(new Error(JSON.stringify(msg.error)))
        else r(msg.result)
      }
    }
    ws.onerror = (e) => rej(new Error(`CDP socket error: ${e.message || 'unknown'}`))
    ws.onopen = () => {
      const send = (method, params) => new Promise((r, j) => {
        const n = ++id
        waiting.set(n, { resolve: r, reject: j })
        ws.send(JSON.stringify({ id: n, method, params }))
      })
      res({
        send,
        eval: async (expression) => {
          const r = await send('Runtime.evaluate', { expression, returnByValue: true })
          if (r.exceptionDetails) throw new Error(`page threw evaluating ${expression}: ${JSON.stringify(r.exceptionDetails.exception)}`)
          return r.result.value
        },
        close: () => ws.close(),
      })
    }
  })
}
