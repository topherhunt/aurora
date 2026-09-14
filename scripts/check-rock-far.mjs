// A far boulder's six-face hull, checked against the mesh it replaces: one
// rock drawn both ways under the same light, the same eye and the same
// instance matrices (rock-far-probe.html), the two pictures' mean colour,
// mean brightness and covered ground compared.
//
// The hull is shaded off the ellipsoid in the mesh's box and drawn through the
// ordinary rock material, and whether that reads as the mesh's colour and
// outline cannot be checked without a renderer, so this gate drives the page
// in headless Chrome over the DevTools protocol and reads the JSON it writes
// into #out. A page that never finishes fails; a machine with no Chrome SKIPS
// loudly, as check-shaders does without glslang.
//
// Usage: node scripts/check-rock-far.mjs [--shot out.png] [--report out.json]   (the page as a person sees it; the JSON it measured)

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const ROOT = new URL('..', import.meta.url).pathname
const PORT = 5213
const PAGE = '/rock-far-probe.html'
const PAGE_URL = `https://localhost:${PORT}${PAGE}`
const TIMEOUT_MS = 240000
const arg = (flag) => process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : null
const SHOT = arg('--shot')
const REPORT = arg('--report')

// Brightness and colour within a tenth. Ground covered: the hull is the
// mesh's box with a vertex or an edge at every extreme, so it covers what the
// mesh covers square on and less from every other eye -- over the flat rows
// four fifths to nineteen twentieths on a rock, and on the hill, where the
// bed buries a rock to its shoulders and the mesh shows a dome, the hull
// shows a wedge: two thirds of the mesh's ground over the row, a third on the
// rock that shows least. The gate guards a quarter over the bed, and on each
// rock what a hull drawn on the wrong rock, at the wrong roll, or without its
// skirt would break: on the flat within COVER_ONE either way; on the hill
// half the row's ground and a quarter of any rock's, hidden by the hill
// exactly when the mesh is.
const LUMA_TOL = 0.10
const CHROMA_TOL = 0.04
const COVER_TOL = 0.25
const COVER_ONE = 1.4
const COVER_HILL = 0.5
const COVER_HILL_ONE = 0.25

const chrome = findChrome()
if (!chrome) {
  console.log('SKIP  check-rock-far: no headless Chrome (playwright chromium_headless_shell or Google Chrome)')
  process.exit(0)
}

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const profile = mkdtempSync(join(tmpdir(), 'rock-far-'))
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
  if (REPORT) writeFileSync(REPORT, text)
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
  console.log(` FAIL  check-rock-far: ${failed.message}`)
  process.exit(1)
}

console.log(`far rock probe on ${report.renderer}`)
console.log(`boulder ${report.measured.width.toFixed(2)} x ${report.measured.height.toFixed(2)} x ${report.measured.depth.toFixed(2)} m`)
check(report.far.tier === 'T6' && report.far.triangles === 6, 'the far tier drawn is the six-triangle hull', `${report.far.tier}, ${report.far.triangles} triangles`)

for (const row of report.rows) {
  const { mesh, far } = row
  const luma = far.luma / mesh.luma
  // Chroma as the channel's share of the whole, so a brightness miss is not
  // counted twice.
  const share = (c) => [c.r, c.g, c.b].map((v) => v / (c.r + c.g + c.b))
  const [mr, , mb] = share(mesh)
  const [cr, , cb] = share(far)
  const chroma = Math.max(Math.abs(cr - mr), Math.abs(cb - mb))
  const cover = far.pixels / mesh.pixels
  const tag = `sun ${row.sun}`
  check(Math.abs(luma - 1) <= LUMA_TOL,
    `${tag}: the hull is as bright as the mesh`,
    `hull/mesh luma ${luma.toFixed(3)} (mesh ${mesh.luma.toFixed(3)}, hull ${far.luma.toFixed(3)}), want within ${LUMA_TOL}`)
  check(chroma <= CHROMA_TOL,
    `${tag}: and the same colour`,
    `worst channel share off by ${chroma.toFixed(3)}, want within ${CHROMA_TOL}`)
  check(Math.abs(cover - 1) <= COVER_TOL,
    `${tag}: and covers the ground the mesh covers`,
    `hull/mesh pixels ${cover.toFixed(3)} (${far.pixels} / ${mesh.pixels}), want within ${COVER_TOL}`)
  if (mesh.each) {
    const idx = report.placements.map((p, i) => i)
    const flat = idx.filter((i) => !report.placements[i].includes('hill'))
    const hill = idx.filter((i) => report.placements[i].includes('hill'))
    const ratio = (i) => far.each[i] / mesh.each[i]
    const worst = (list) => list.reduce((w, i) => Math.abs(Math.log(ratio(i))) > Math.abs(Math.log(ratio(w))) ? i : w, list[0])
    const px = (i) => `${report.placements[i]} (mesh ${mesh.each[i]}, hull ${far.each[i]} px)`
    const w = worst(flat)
    check(flat.every((i) => ratio(i) <= COVER_ONE && ratio(i) >= 1 / COVER_ONE),
      `${tag}: on every roll the bed can draw on the flat`,
      `hull/mesh ${Math.min(...flat.map(ratio)).toFixed(2)} .. ${Math.max(...flat.map(ratio)).toFixed(2)}, worst ${px(w)}, want each within ${COVER_ONE}x`)
    const sum = (list, each) => list.reduce((n, i) => n + each[i], 0)
    const hillCover = sum(hill, far.each) / sum(hill, mesh.each)
    check(hillCover >= COVER_HILL && hillCover <= 1 + COVER_TOL,
      `${tag}: and sunk to the bed's cap on the hill, shows the ground the mesh shows`,
      `hull/mesh pixels ${hillCover.toFixed(3)} over the hill rows, want ${COVER_HILL} .. ${(1 + COVER_TOL).toFixed(2)}`)
    const buried = hill.filter((i) => (mesh.each[i] === 0) !== (far.each[i] === 0))
    const shown = hill.filter((i) => mesh.each[i] > 0 && far.each[i] > 0)
    const hw = worst(shown)
    check(buried.length === 0 && shown.every((i) => ratio(i) >= COVER_HILL_ONE && ratio(i) <= COVER_ONE),
      `${tag}: and on every rock there, hidden by the hill exactly when the mesh is`,
      buried.length ? `hidden on one side only: ${buried.map(px).join('; ')}` : `hull/mesh ${Math.min(...shown.map(ratio)).toFixed(2)} .. ${Math.max(...shown.map(ratio)).toFixed(2)} over ${shown.length} showing, ${hill.length - shown.length} buried, worst ${px(hw)}, want each ${COVER_HILL_ONE} .. ${COVER_ONE}`)
  }
}

console.log(`\n${failures === 0 ? 'all far rock checks passed' : `${failures} FAILED`}\n`)
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
