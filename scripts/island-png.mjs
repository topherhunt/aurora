// The v3 island as a PNG -- §31's headless eye.
//
//   node scripts/island-png.mjs [--seed N] [--layer relief|elev|slope|bowls|biomes] [--jitter key=value,...] [--out path]
//
// Draws exactly what /terrain-v3-map draws, through the same painters in src/v3/paint.js, so a picture taken here and a picture taken there are the same instrument.

import { writeFile } from 'node:fs/promises'
import { encodePng } from '../src/v2/height/png.js'
import { generate } from '../src/v3/generate.js'
import { derive, paintInto, LAYERS } from '../src/v3/paint.js'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}
const seed = Number(opt('seed', 20260824))
const layer = opt('layer', 'relief')
const out = opt('out', `tmp/island-${seed}-${layer}.png`)
// `--jitter byHeight=1,start=256`: overrides for JITTER, numbers parsed, so a knob can be tried without editing island.js.
const jitter = opt('jitter', '') ? Object.fromEntries(opt('jitter', '').split(',').map((kv) => { const [k, v] = kv.split('='); return [k, Number.isNaN(Number(v)) ? v : Number(v)] })) : null
if (!LAYERS.some(([id]) => id === layer)) throw new Error(`island-png: unknown layer ${layer}, expected one of ${LAYERS.map(([id]) => id).join(', ')}`)

const r = derive(generate({ seed, jitter, log: (line) => console.log(line) }))
const rgba = new Uint8ClampedArray(r.n * r.n * 4)
paintInto(rgba, r, layer)
const rgb = new Uint8Array(r.n * r.n * 3)
for (let c = 0; c < r.n * r.n; c++) {
  rgb[c * 3] = rgba[c * 4]
  rgb[c * 3 + 1] = rgba[c * 4 + 1]
  rgb[c * 3 + 2] = rgba[c * 4 + 2]
}
await writeFile(out, await encodePng(r.n, r.n, rgb))
const s = r.stats
console.log(`wrote ${out}  land ${(s.landFraction * 100).toFixed(1)}%  summit ${s.summit.h.toFixed(0)} m at ${s.summit.offset.toFixed(0)} m off centre  coast x${s.coast.irregularity.toFixed(2)}  bowls ${s.bowls.count} (${s.bowls.km2.toFixed(2)} km2)`)
