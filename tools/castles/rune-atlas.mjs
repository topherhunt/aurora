// Regenerates public/buildings/runes.png: ten 128x128 white-on-transparent silhouettes
// (strider, crab, frog, rabbit, deer, fox, dragon, pine, rock, castle). Needs the Vite dev server;
// tmp/runeshot/index.html renders the atlas and this script saves its PNG.
//   node tools/castles/rune-atlas.mjs [baseUrl]   (default https://127.0.0.1:5173)

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { launchChrome } from '../../tmp/headless-chrome.mjs'

const base = process.argv[2] ?? 'https://127.0.0.1:5173'
const out = fileURLToPath(new URL('../../public/buildings/runes.png', import.meta.url))
const PORT = 9347
const chrome = launchChrome({ port: PORT, profile: 'claude-runes-profile', lifetimeSec: 180 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let page
for (let i = 0; i < 60 && !page; i++) {
  try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page') } catch {}
  if (!page) await sleep(250)
}
if (!page) throw new Error(`no debug target. chrome said:\n${chrome.errText}`)

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const pending = new Map()
const said = []
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
  } else if (msg.method === 'Runtime.exceptionThrown' || msg.method === 'Runtime.consoleAPICalled') said.push(JSON.stringify(msg.params).slice(0, 400))
}
const send = (method, params = {}) => new Promise((res, rej) => {
  const n = ++id
  pending.set(n, { res, rej })
  ws.send(JSON.stringify({ id: n, method, params }))
})
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value

try {
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Page.navigate', { url: `${base}/tmp/runeshot/index.html` })
  const deadline = Date.now() + 90000
  while (Date.now() < deadline && !(await evaluate('window.PROBE_DONE === true'))) await sleep(300)
  const url = await evaluate('window.__atlas')
  if (!url) throw new Error(`atlas not produced. page said:\n${said.join('\n')}`)
  writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'))
  console.log(`wrote ${out}`)
} finally {
  ws.close()
  chrome.kill()
}
