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
//   public/world/height.png via POST /__height -- the same store for the one
//     edit that is not a document. The terrain brush writes texels of the import
//     itself, so there is nothing parametric to keep and nowhere else to put it;
//     see src/v2/height/sculpt.js. It has NO localStorage tier and no export
//     button on purpose: a megabyte of PNG per commit would blow the storage
//     quota, and a sculpt that only exists in a browser profile is a sculpt
//     nobody else will ever see.
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
const HEIGHT_ENDPOINT = '/__height'

/**
 * The endpoint's answer, or a throw that names the ACTUAL problem.
 *
 * THE FAILURE THIS EXISTS FOR, because it cost an hour of sculpting once. A dev
 * server that was started before an endpoint was written does not 404 that
 * route: vite's SPA fallback answers index.html with a **200**, so `res.ok` is
 * true, the body is HTML, and a bare `JSON.parse` throws "Unexpected token '<'".
 * That message names neither the file that did not save nor the reason, and the
 * reason is one Ctrl-C away. So an HTML body is diagnosed here, on any status.
 */
function answerOf(res, body, endpoint) {
  if (body.trimStart().startsWith('<')) {
    throw new Error(
      `${endpoint} is not being served -- the dev server was started before that route existed. ` +
        'Restart it (Ctrl-C in the dev terminal, then npm run dev) and press Save again. ' +
        'Nothing is lost as long as this tab is not reloaded.'
    )
  }
  let json
  try {
    json = JSON.parse(body)
  } catch {
    throw new Error(`${endpoint} answered HTTP ${res.status} with a body that is not JSON: ${body.slice(0, 120)}`)
  }
  if (!res.ok) throw new Error(`save to ${endpoint} failed: ${json.error ?? `HTTP ${res.status}`}`)
  if (json.ok !== true) throw new Error(`save to ${endpoint} refused: ${json.error}`)
  return json
}

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
 * middleware. Resolves to the endpoint's `{ok, path, bytes}`; throws through
 * answerOf otherwise, so a build with no middleware reads as "that route is not
 * served" in the panel rather than as a save that quietly did nothing.
 */
export async function saveServer(layers) {
  const text = JSON.stringify(layers.serialize())
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: text,
  })
  return answerOf(res, await res.text(), ENDPOINT)
}

/**
 * Write the SCULPTED HEIGHTMAP to `public/world/height.png` through the dev
 * server. Same shape as saveServer above and deliberately a separate call: the
 * document is kilobytes and saves on every commit, while this is a megabyte of
 * PNG that only exists once someone has used the terrain brush.
 *
 * The encode happens here rather than in the endpoint because the browser is
 * where the field lives -- see Heightmap.toPng, which is the exact inverse of
 * the rg16 encoding scripts/make-heightmap.mjs writes.
 */
export async function saveHeightServer(heightmap) {
  const bytes = await heightmap.toPng()
  const res = await fetch(HEIGHT_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: bytes,
  })
  return answerOf(res, await res.text(), HEIGHT_ENDPOINT)
}

/**
 * THE ESCAPE HATCH: the sculpted field into the downloads folder, as a PNG that
 * can simply be copied over public/world/height.png.
 *
 * Called when the server save FAILS. The document has a localStorage tier and a
 * megabyte of PNG cannot have one, so without this a heightmap that could not
 * reach the dev server exists in exactly one place -- a tab, one Cmd-R from
 * gone. A file in ~/Downloads survives the tab, the server and the reload.
 */
export async function exportHeightFile(heightmap, name = 'height.png') {
  const bytes = await heightmap.toPng()
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return { name, bytes: bytes.length }
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
