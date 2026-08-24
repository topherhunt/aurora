import { LAYERS_URL } from '../config.js'
import { emptyDoc } from './restore.js'

// ---------------------------------------------------------------------------
// Where an authored world lives, and in what order it is looked for.
//
// Three stores, because they answer three different questions:
//
//   localStorage -- survives a reload. Written on every commit, so a crash or an
//     accidental refresh costs nothing. It is invisible to git and dies with the
//     browser profile, so it is a scratchpad and never the source of truth.
//   public/world/layers.json via POST /__world -- survives a machine, and is
//     COMMITTABLE. This is the source of truth. Dev server only: the middleware
//     is `apply: 'serve'` in vite.config.js, so a deployed build has no writer
//     and Export is the answer there.
//   Export / Import files -- move a world between machines, and are the escape
//     hatch when the dev server is not running.
//
// LOAD PRECEDENCE ON BOOT, and the reasoning: server file, then localStorage,
// then an empty document. The committed file wins because it is the one another
// person -- or this person on another machine -- can also see; letting a stale
// localStorage shadow a freshly pulled layers.json would mean editing a world
// that does not match the repo and never being told. The cost is that unsaved
// localStorage work is not restored once a server file exists, which is why
// `loadInitial` reports WHICH store it read from and the panel prints it.
// ---------------------------------------------------------------------------

const KEY = 'aurora.v2.world'
const ENDPOINT = '/__world'

export function saveLocal(layers) {
  const text = JSON.stringify(layers.serialize())
  // A quota failure is real and must be seen -- silently not autosaving looks
  // exactly like autosaving right up until the reload that loses the world.
  localStorage.setItem(KEY, text)
  return text.length
}

export function loadLocal() {
  const text = localStorage.getItem(KEY)
  if (text === null) return null
  return JSON.parse(text)
}

export function clearLocal() {
  localStorage.removeItem(KEY)
}

/**
 * Write the document to `public/world/layers.json` through the dev-server
 * middleware. Resolves to the endpoint's `{ok, path, bytes}`; throws with the
 * server's own message otherwise, so a build with no middleware (which answers
 * the SPA fallback HTML, not JSON) reads as "no dev server" in the panel rather
 * than as a save that quietly did nothing.
 */
export async function saveServer(layers) {
  const text = JSON.stringify(layers.serialize())
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: text,
  })
  const body = await res.text()
  if (!res.ok) {
    let msg = body.slice(0, 200)
    try {
      msg = JSON.parse(body).error
    } catch {
      msg = `HTTP ${res.status} -- ${msg}` // not JSON at all: almost certainly the SPA fallback
    }
    throw new Error(`save to ${ENDPOINT} failed: ${msg}`)
  }
  const json = JSON.parse(body)
  if (json.ok !== true) throw new Error(`save to ${ENDPOINT} refused: ${json.error}`)
  return json
}

/** The committed world, or null when nothing has been authored yet. */
export async function loadServer() {
  const res = await fetch(LAYERS_URL, { cache: 'no-store' })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`load ${LAYERS_URL} failed: HTTP ${res.status}`)
  const text = await res.text()
  // The dev server answers index.html for a missing static file rather than 404,
  // so "did I get a document" is a question about the body, not the status.
  if (text.trimStart().startsWith('<')) return null
  return JSON.parse(text)
}

/**
 * Boot-time load, applying the precedence documented in the header. Returns
 * `{doc, from}` where `from` is 'server' | 'local' | 'empty', so the panel can
 * say which one it got.
 *
 * `snow` is `{base, band}` in metres and is only used when nothing has been
 * authored yet -- but it is required rather than defaulted, because it is the
 * one number in an empty world that depends on the heightmap bake. See
 * emptyDoc().
 */
export async function loadInitial(snow) {
  const server = await loadServer()
  if (server) return { doc: server, from: 'server' }
  const local = loadLocal()
  if (local) return { doc: local, from: 'local' }
  return { doc: emptyDoc(snow.base, snow.band), from: 'empty' }
}

export function exportFile(layers, name = 'layers.json') {
  const text = JSON.stringify(layers.serialize(), null, 2)
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  // Revoke on the next task, not immediately: the click is synchronous but the
  // browser's fetch of the blob is not, and revoking in the same tick cancels
  // the download on Safari.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return text.length
}

/**
 * Open a file picker and resolve to the parsed document. Never resolves if the
 * user dismisses the dialog -- there is no cancel event for `<input type=file>`
 * that is reliable across browsers, and a picker that was closed and a picker
 * that is still open are the same thing to the page.
 */
export function importFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json,.json'
    input.style.display = 'none'
    document.body.appendChild(input)
    input.addEventListener('change', () => {
      const file = input.files[0]
      input.remove()
      if (!file) return
      file
        .text()
        .then((text) => resolve(JSON.parse(text)))
        .catch(reject)
    })
    input.click()
  })
}
