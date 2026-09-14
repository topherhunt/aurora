// ---------------------------------------------------------------------------
// Rescale every ELEVATION in an authored v2 world document.
//
//   node scripts/rescale-world.mjs 2          public/world/layers.json in place
//   node scripts/rescale-world.mjs 2 --dry    print what would change
//
// WHY THIS EXISTS. The vertical scale of the v2 world is not in the PNG -- the
// image stores normalised levels and `world/height.json` says what 0 and 65535
// mean in metres, so re-baking with a different --maxY moves every mountain
// without touching a texel. The authored layers do not follow: a lake's `y` is
// an absolute elevation in metres, and after a re-bake it is an elevation of
// the world that used to be there. A lake sits 300 m in the air, a road runs
// along a contour that is now half way down the valley wall, and nothing
// reports an error because every one of those numbers is still perfectly valid.
// (Rivers are the exception: a river node is XZ only and its level is solved
// from whatever terrain is there, so it follows a re-bake on its own.)
//
// WHAT SCALES AND WHAT DOES NOT, which is the only interesting decision here:
//
//   scales      snow.base, snow.band, every snow point's delta, every lake's y,
//               every road control point's y. These are positions in, or fractions
//               of, the world's vertical extent -- double the relief and they
//               all double with it. (A snow BAND is the soft edge of the cover,
//               which is a fraction of the relief and not a physical depth.)
//
//   does not    lake `depth`, river `depth`, road `feather`, every x/z, every
//               `width`, `rx`, `rz`, `rot`. A river is about two metres deep
//               because that is how deep a river is, not because of how tall
//               the mountains are, and a horizontal extent has nothing to do
//               with the vertical scale at all.
//
// The rewrite is by KEY, not by walking the arrays positionally, so a document
// that gains a field keeps it and a version bump fails loudly at validate()
// rather than silently scaling the wrong slot.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { validate } from '../src/v2/layers/doc.js'

const DEFAULT_PATH = new URL('../public/world/layers.json', import.meta.url)

export function rescaleDoc(doc, k) {
  if (!Number.isFinite(k) || k <= 0) throw new Error(`rescale-world: factor must be a positive number, got ${k}`)
  validate(doc)

  const out = {
    ...doc,
    snow: {
      ...doc.snow,
      base: doc.snow.base * k,
      band: doc.snow.band * k,
      // No tombstone handling anywhere in here: the runtime nulls a removed
      // slot to keep the indices above it stable, but toJSON compacts them out
      // and validate() refuses a null, so a document on disk has no holes.
      points: doc.snow.points.map((p) => [p[0], p[1], p[2] * k, p[3]]),
    },
    lakes: doc.lakes.map((l) => ({ ...l, y: l.y * k })),
    // A river node is [x, z] or [x, z, width]: no elevation to scale.
    rivers: doc.rivers.map((r) => ({ ...r, pts: r.pts.map((p) => p.slice()) })),
    roads: doc.roads.map((rec) => ({ ...rec, pts: rec.pts.map((p) => [p[0], p[1] * k, p[2], p[3]]) })),
  }

  return validate(out)
}

function summarise(doc) {
  const ys = []
  for (const p of doc.snow.points) if (p !== null) ys.push(doc.snow.base + p[2])
  for (const l of doc.lakes) ys.push(l.y)
  for (const rec of doc.roads) for (const p of rec.pts) if (p !== null) ys.push(p[1])
  if (ys.length === 0) return 'nothing authored'
  return `${ys.length} elevations, ${Math.min(...ys).toFixed(1)} .. ${Math.max(...ys).toFixed(1)} m`
}

async function main(argv) {
  const dry = argv.includes('--dry')
  const rest = argv.filter((a) => a !== '--dry')
  const k = Number(rest[0])
  if (!Number.isFinite(k) || k <= 0) {
    throw new Error('usage: node scripts/rescale-world.mjs <factor> [path/to/layers.json] [--dry]')
  }
  const path = rest[1] ? pathToFileURL(rest[1]) : DEFAULT_PATH

  const before = JSON.parse(readFileSync(path, 'utf8'))
  const after = rescaleDoc(before, k)

  console.log(`${fileURLToPath(path)}`)
  console.log(`  before  snow ${before.snow.base.toFixed(1)} +/- ${before.snow.band.toFixed(1)} m, ${summarise(before)}`)
  console.log(`  after   snow ${after.snow.base.toFixed(1)} +/- ${after.snow.band.toFixed(1)} m, ${summarise(after)}`)

  if (dry) {
    console.log('  --dry: nothing written')
    return
  }
  writeFileSync(path, JSON.stringify(after) + '\n')
  console.log('  written')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2))
}
