import { WORLD_SIZE } from '../v2/config.js'
import { generate } from './generate.js'
import { cacheKey, writeTiles } from './store.js'
import { DECIMATE, TILE_M, baseTexelsFor, decimate, eachTile, subsampleClasses, tileCount } from './tiles.js'

// ---------------------------------------------------------------------------
// The generator off the main thread -- §31. One message in ({ seed, n, tune }), log
// lines out as they happen, then the island.
//
// THIS WORKER IS THE ONLY PLACE THE WHOLE 2 M FIELD EVER EXISTS, and that is the
// memory design (§31, the elevation pyramid, and src/v3/tiles.js). 4097^2 Float32
// is 64 MB; the page gets the 8 m base, 4.0 MB, and the 2 m detail goes to 1024
// IndexedDB records that the page reads back a handful at a time. So the peak lives
// for the 75 s of one generate inside a worker that is terminated immediately after,
// instead of three times over for as long as the tab is open.
//
// THE ORDER MATTERS: tiles are written before the result is posted. The page writes
// the island record only once this resolves, so a tab killed mid-bake leaves tiles
// with no record -- a plain cache miss -- rather than a record whose detail is
// missing, which would stand up a world that is silently 8 m everywhere.
// ---------------------------------------------------------------------------

self.onmessage = async (e) => {
  const { seed, n, tune, fine = false } = e.data
  const log = (line) => self.postMessage({ type: 'log', line })
  try {
    const r = generate({ seed, n, tune, log })

    const t0 = performance.now()
    const baseN = baseTexelsFor(r.n)
    const base = decimate(r.height, r.n, DECIMATE)
    if (base.n !== baseN) throw new Error(`v3 worker: decimate made ${base.n}^2, expected ${baseN}^2`)
    const classes = subsampleClasses(r.ground, r.n, DECIMATE)
    const baseCell = WORLD_SIZE / (baseN - 1)
    log(`pyramid        base ${baseN}^2 at ${baseCell.toFixed(1)} m (${(base.data.byteLength / 1048576).toFixed(2)} MB), classes ${(classes.byteLength / 1048576).toFixed(2)} MB`)

    let written = 0
    await writeTiles(cacheKey(seed, tune), (put) => {
      written = eachTile(r.height, r.n, r.cell, (t) => put(t.key, t.data))
    })
    const want = tileCount() ** 2
    if (written !== want) throw new Error(`v3 worker: cut ${written} tiles, the ${TILE_M} m grid over ${WORLD_SIZE} m needs ${want}`)
    log(`tiles          ${((performance.now() - t0) / 1000).toFixed(1)} s  ${written} tiles of ${TILE_M} m at ${r.cell.toFixed(1)} m, cached`)

    // The fine field and the fine class grid do NOT go in the result: that is the
    // whole point. `fineN`/`fineCell` record the pitch the tiles are at, because
    // FineJitter's octave split was made against the FINE cell and handing it the
    // base cell would have it re-add rungs the tiles already carry.
    const result = {
      ...r,
      n: baseN,
      cell: baseCell,
      height: base.data,
      ground: classes,
      meta: { ...r.meta, size: baseN },
      fineN: r.n,
      fineCell: r.cell,
      tiles: { count: written, metres: TILE_M, cell: r.cell, decimate: DECIMATE },
    }
    const transfer = [result.height.buffer, result.ground.buffer]
    // THE ONE CALLER THAT WANTS THE WHOLE 2 M FIELD is /terrain-v3-map, which paints
    // every texel of it and is the instrument the 2 m pitch exists to be judged on.
    // It is handed over rather than stored: store.js strips these two before the
    // record is cached, so the field that must not be resident on the 3D route is not
    // in the cache for it to read. TRANSFERRED, so this costs no copy -- and this
    // worker is terminated on the next line's reply anyway.
    if (fine) {
      result.fineHeight = r.height
      result.fineGround = r.ground
      transfer.push(r.height.buffer, r.ground.buffer)
    }
    self.postMessage({ type: 'done', result }, transfer)
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message, stack: err.stack })
  }
}
