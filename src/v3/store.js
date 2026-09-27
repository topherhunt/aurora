import { VERSION, tuneKey } from './generate.js'
import { tileCount } from './tiles.js'

// ---------------------------------------------------------------------------
// The island's cache and the road to it -- §31.
//
// `load({ seed, regen, tune, log })` answers with a generator result, from IndexedDB when one is there for this seed, this VERSION of the algorithm and this tune, and from the worker otherwise, storing what the worker made. The key carries the algorithm version so that a change to any stage invalidates every client's copy the next time it boots: nothing else does, and a stale island would look exactly like a real one. It carries the tune's signature too, so /terrain-v3's layer switches flip back to an island already generated instead of overwriting the one they were compared against.
// ---------------------------------------------------------------------------

const DB = 'aurora-v3'
const STORE = 'islands'
// The fine tiles, one record each, keyed `<cacheKey>|<tx>,<tz>` -- see tiles.js.
// Their own store rather than a field on the island record, because the whole
// point is to read ONE tile without deserialising the other 1023.
const TILES = 'tiles'
const DB_VERSION = 2

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
      if (!db.objectStoreNames.contains(TILES)) db.createObjectStore(TILES)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx(db, mode, fn, store = STORE) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode)
    const req = fn(t.objectStore(store))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export const cacheKey = (seed, tune = null) => `${seed}:${VERSION}:${tuneKey(tune)}`

async function read(seed, tune) {
  const db = await open()
  try {
    return (await tx(db, 'readonly', (s) => s.get(cacheKey(seed, tune)))) ?? null
  } finally {
    db.close()
  }
}

async function write(seed, tune, result) {
  const db = await open()
  try {
    await tx(db, 'readwrite', (s) => s.put(result, cacheKey(seed, tune)))
  } finally {
    db.close()
  }
}

export async function clear() {
  const db = await open()
  try {
    await tx(db, 'readwrite', (s) => s.clear())
    await tx(db, 'readwrite', (s) => s.clear(), TILES)
  } finally {
    db.close()
  }
}

// --- the fine tiles ---------------------------------------------------------
//
// The island record holds the 8 m base; the 2 m detail lives here, one record a
// tile, and only the handful near the eye is ever read into memory. See
// src/v3/tiles.js for the geometry and why.

/**
 * Write every tile of one island in a single transaction. `emit(put)` is called
 * synchronously and must issue all its puts before returning -- an IndexedDB
 * transaction commits as soon as control reaches the event loop with nothing
 * pending, so an `await` inside `emit` would commit a partial island.
 */
export async function writeTiles(key, emit) {
  const db = await open()
  try {
    await new Promise((resolve, reject) => {
      const t = db.transaction(TILES, 'readwrite')
      const s = t.objectStore(TILES)
      t.oncomplete = () => resolve()
      t.onerror = () => reject(t.error)
      t.onabort = () => reject(t.error ?? new Error(`v3: the tile write for ${key} aborted`))
      emit((tk, data) => s.put(data, `${key}|${tk}`))
    })
  } finally {
    db.close()
  }
}

// One connection held open for the read path. A tile is fetched as the player
// walks into it, and open/close per tile is a database handshake on the critical
// path of the ground appearing.
let reader = null
async function readerDb() {
  if (reader === null) reader = await open()
  return reader
}

/** One tile's Float32Array, or null when it was never written. */
export async function readTile(key, tk) {
  const db = await readerDb()
  return (await tx(db, 'readonly', (s) => s.get(`${key}|${tk}`), TILES)) ?? null
}

/** How many tiles this island has stored. The integrity check: a cache hit whose tiles were lost is a cache miss. */
export async function countTiles(key) {
  const db = await readerDb()
  const range = IDBKeyRange.bound(`${key}|`, `${key}|￿`)
  return await tx(db, 'readonly', (s) => s.count(range), TILES)
}

function runWorker(seed, tune, log, fine) {
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
    worker.postMessage({ seed, tune, fine })
  })
}

/**
 * The island for `seed` and `tune`: cached, or generated in the worker and then cached. `from` says which. `regen` skips the read but still writes, so `?regen` is how a client is made to take a new algorithm before its VERSION is bumped. `tune` (the amplitudes and step switches, see generate) goes to the worker and is cached with the result under its own signature, so /terrain-v3 flies the island the map page last made at those settings and a switched-off layer can be switched back on without waiting for the worker again.
 *
 * `fine` asks for the whole 2 m field and its class grid as well, as `result.fineHeight` and `result.fineGround`. Only /terrain-v3-map wants them -- it paints every texel -- and they are NOT part of the cached record: 84 MB per cache slot that only one page reads, and a record the 3D route could then accidentally hold. It forces the worker for the same reason, since the cache is the one place the fine field deliberately is not.
 */
export async function load({ seed, regen = false, tune = null, fine = false, log = () => {} }) {
  if (fine && !regen) throw new Error('v3 load: fine needs regen -- the whole 2 m field is not in the cache, only its tiles')
  const key = cacheKey(seed, tune)
  if (!regen) {
    const hit = await read(seed, tune)
    if (hit) {
      // A HIT IS ONLY A HIT IF ITS TILES ARE THERE TOO. The island record and its
      // tiles are written in separate transactions -- the worker writes the tiles,
      // the page writes the record -- so a tab closed in between, or a storage
      // eviction that took one store and not the other, leaves a base field whose
      // detail is gone. Standing that up would draw a world that is quietly 8 m
      // everywhere, which looks like a bad island rather than a broken cache.
      const want = tileCount() ** 2
      const have = await countTiles(key)
      if (have === want) {
        log(`island ${seed} from IndexedDB (${hit.v}), ${have} tiles`)
        return { result: hit, from: 'cache', key }
      }
      log(`island ${seed} is cached but ${have} of ${want} tiles are missing -- regenerating`)
    }
  }
  const result = await runWorker(seed, tune, log, fine)
  // The fine arrays go to the caller and stay out of the record. A shallow copy is
  // enough: IndexedDB structured-clones what it stores, and every other field of the
  // result is meant to be in there.
  const record = { ...result }
  record.fineHeight = undefined
  record.fineGround = undefined
  await write(seed, tune, record)
  log(`island ${seed} generated in ${result.ms.toFixed(0)} ms and cached`)
  return { result, from: 'worker', key }
}

/** The seed and the regen flag off the page's query string: `?seed=N&regen`. */
export function optionsFromUrl(defaultSeed) {
  const q = new URLSearchParams(location.search)
  const seed = q.has('seed') ? Number(q.get('seed')) : defaultSeed
  if (!Number.isInteger(seed)) throw new Error(`v3: ?seed must be an integer, got ${q.get('seed')}`)
  return { seed, regen: q.has('regen') }
}
