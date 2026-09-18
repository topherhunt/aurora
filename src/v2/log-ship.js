// Ship the console to the dev server. A headset has no devtools, so every
// console.warn, console.error, uncaught error and unhandled rejection is also
// POSTed to /__log (vite.config.js, dev only), which appends it to
// tmp/client-log.txt on the machine serving the world -- readable afterwards
// with `curl -sk https://localhost:5173/__log?tail=50`.
//
// The console itself is untouched: each wrapper calls the original first, so
// the desktop devtools see exactly what they always did, and a failure to ship
// is swallowed rather than reported through the very console it wraps (that
// would recurse). Nothing here runs in a production build -- the endpoint only
// exists under `vite serve` -- so the whole install is gated on DEV.
//
// IT RATE-LIMITS ITSELF, because the one case it exists for is a warning that
// fires every frame: a throw inside a tick reaches window.onerror seventy
// times a second, and shipping each copy would be 70 requests a second from a
// headset on wifi. Entries are batched and flushed once a second; a message
// identical to the one before it is counted rather than repeated; and past
// SESSION_CAP entries in one page load the shipper goes quiet with one last
// line saying so. The server caps the file on its side as well.

const ENDPOINT = '/__log'
const FLUSH_MS = 1000
const SESSION_CAP = 500
const MESSAGE_CAP = 4000

const queue = []
let shipped = 0
let muted = false
let timer = null
let last = null

const fmt = (a) => {
  if (a instanceof Error) return String(a.message) // its stack ships as `stack`
  if (typeof a === 'string') return a
  try {
    return JSON.stringify(a)
  } catch {
    return String(a)
  }
}

const flush = () => {
  timer = null
  if (!queue.length) return
  const batch = queue.splice(0, queue.length).map(({ at, level, message, stack }) => ({ at, level, message, stack }))
  // keepalive so a batch queued as the page unloads still gets out.
  fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(batch), keepalive: true }).catch(() => {})
}

const push = (level, message, stack) => {
  if (muted) return
  // A repeat of the entry before it is counted onto that entry -- which is
  // still in the queue if it has not flushed yet, and a fresh line if it has.
  if (last && last.level === level && last.raw === message && queue.includes(last)) {
    last.repeats++
    last.message = `${last.raw.slice(0, MESSAGE_CAP)} (x${last.repeats})`
    return
  }
  if (++shipped > SESSION_CAP) {
    muted = true
    queue.push({ at: new Date().toISOString(), level: 'log', message: `log-ship: ${SESSION_CAP} entries this session, shipping no more` })
  } else {
    last = { at: new Date().toISOString(), level, message: message.slice(0, MESSAGE_CAP), raw: message, repeats: 1 }
    if (stack) last.stack = String(stack).slice(0, MESSAGE_CAP)
    queue.push(last)
  }
  if (timer === null) timer = setTimeout(flush, FLUSH_MS)
}

/** Wrap the console and the window's error events. Dev builds only; idempotent. */
export function installLogShip() {
  if (!import.meta.env.DEV || installLogShip.done) return
  installLogShip.done = true
  for (const level of ['warn', 'error']) {
    const original = console[level].bind(console)
    console[level] = (...args) => {
      original(...args)
      const err = args.find((a) => a instanceof Error)
      push(level, args.map(fmt).join(' '), err?.stack)
    }
  }
  window.addEventListener('error', (e) => {
    const err = e.error
    push('error', `uncaught: ${err?.message ?? e.message}`, err?.stack)
  })
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason
    push('error', `unhandled rejection: ${r instanceof Error ? r.message : fmt(r)}`, r instanceof Error ? r.stack : undefined)
  })
  window.addEventListener('pagehide', flush)
  push('log', `log-ship: session start ${navigator.userAgent}`)
}
