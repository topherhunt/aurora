import { VERSION } from './generate.js'

// ---------------------------------------------------------------------------
// The island's cache and the road to it -- §31.
//
// `load({ seed, regen, log })` answers with a generator result, from IndexedDB when one is there for this seed and this VERSION of the algorithm, and from the worker otherwise, storing what the worker made. The key carries the algorithm version so that a change to any stage invalidates every client's copy the next time it boots: nothing else does, and a stale island would look exactly like a real one.
// ---------------------------------------------------------------------------

const DB = 'aurora-v3'
const STORE = 'islands'

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const req = fn(t.objectStore(STORE))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export const cacheKey = (seed) => `${seed}:${VERSION}`

async function read(seed) {
  const db = await open()
  try {
    return (await tx(db, 'readonly', (s) => s.get(cacheKey(seed)))) ?? null
  } finally {
    db.close()
  }
}

async function write(seed, result) {
  const db = await open()
  try {
    await tx(db, 'readwrite', (s) => s.put(result, cacheKey(seed)))
  } finally {
    db.close()
  }
}

export async function clear() {
  const db = await open()
  try {
    await tx(db, 'readwrite', (s) => s.clear())
  } finally {
    db.close()
  }
}

function runWorker(seed, tune, log) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
    worker.onmessage = (e) => {
      const m = e.data
      if (m.type === 'log') {
        log(m.line)
        return
      }
      worker.terminate()
      if (m.type === 'error') {
        const err = new Error(m.message)
        err.stack = m.stack
        reject(err)
        return
      }
      resolve(m.result)
    }
    worker.onerror = (e) => {
      worker.terminate()
      reject(e.error || new Error(e.message || 'v3 worker failed'))
    }
    worker.postMessage({ seed, tune })
  })
}

/**
 * The island for `seed`: cached, or generated in the worker and then cached. `from` says which. `regen` skips the read but still writes, so `?regen` is how a client is made to take a new algorithm before its VERSION is bumped. `tune` (the map page's amplitudes, see generate) goes to the worker and is cached with the result under the seed's own key, so /terrain-v3 flies the island the map page last made.
 */
export async function load({ seed, regen = false, tune = null, log = () => {} }) {
  if (!regen) {
    const hit = await read(seed)
    if (hit) {
      log(`island ${seed} from IndexedDB (${hit.v})`)
      return { result: hit, from: 'cache' }
    }
  }
  const result = await runWorker(seed, tune, log)
  await write(seed, result)
  log(`island ${seed} generated in ${result.ms.toFixed(0)} ms and cached`)
  return { result, from: 'worker' }
}

/** The seed and the regen flag off the page's query string: `?seed=N&regen`. */
export function optionsFromUrl(defaultSeed) {
  const q = new URLSearchParams(location.search)
  const seed = q.has('seed') ? Number(q.get('seed')) : defaultSeed
  if (!Number.isInteger(seed)) throw new Error(`v3: ?seed must be an integer, got ${q.get('seed')}`)
  return { seed, regen: q.has('regen') }
}
