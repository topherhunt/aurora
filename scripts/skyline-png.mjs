// Renders the HORIZON as she would actually see it: a ray-marched skyline from a
// standing eye height, with distance haze so successive ridgelines separate into
// layers. Writes one PNG per viewpoint.
//
//   node scripts/skyline-png.mjs [seed] [outDir]
//
// WHY THIS EXISTS, given that heightmap-png.mjs already renders hillshade.
//
// Every instrument in this repo so far looks STRAIGHT DOWN, and the thing being
// judged -- "rocky jutting majestic mountains, some looming WAY larger than
// others, formidable from a distance" -- is a property of the field seen EDGE
// ON. The two are not interchangeable and the difference is not a matter of
// taste:
//
//   A hillshade shows the GRADIENT everywhere. A skyline shows the UPPER
//   ENVELOPE along a line of sight, which is a max over hundreds of samples --
//   so it is dominated by the few tallest things and completely blind to the
//   rest. A world can hillshade beautifully and have no skyline at all (every
//   summit the same height, so the horizon is a flat band of texture), and that
//   failure is invisible from above because from above the summits look fine.
//
// That is precisely the failure this instrument was written to catch, and it
// caught it on the first run: peak-to-peak variation along the horizon measured
// 1.6 deg where the Skyrim references are nearer 8, because the massif tier is
// an fbm remapped to a fixed 0..1 range and therefore makes every massif the
// same height by construction. No top-down render can show that.
//
// HOW TO READ IT. Near ground is dark, far ground fades to the haze grey, so
// each ridgeline reads as its own layer -- the same cue the references use. The
// printed stats are the ones worth tuning against:
//
//   apex        elevation angle of the highest thing in the view, degrees.
//               The references run 9-14 deg from a valley floor.
//   relief      apex minus the MEDIAN horizon angle. This is the number that
//               says "some loom way larger than others". Under ~4 deg the
//               horizon reads as a wall or a hedge rather than as peaks.
//   layers      how many distinct distance bands the horizon is drawn from.
//               One layer is a wall; the references show four or five.
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { TerrainHeight } from '../src/sim/terrain-height.js'

const SEED = Number(process.argv[2] ?? 20260804)
const OUT = process.argv[3] ?? tmpdir()
mkdirSync(OUT, { recursive: true })

const th = new TerrainHeight(SEED)

// ---- PNG (grayscale, hand-encoded -- same forty lines as heightmap-png.mjs) --
const CRC = new Int32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC[n] = c
}
const crc32 = (buf) => {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function writeGrayPng(path, w, h, px) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 0
  const raw = Buffer.alloc(h * (w + 1))
  for (let y = 0; y < h; y++) px.copy(raw, y * (w + 1) + 1, y * w, (y + 1) * w)
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ])
  )
}

// ---- the march ------------------------------------------------------------
const W = 1200 // columns; one per azimuth sample
const H = 420
const FOV = 75 // degrees horizontal
const VTOP = 16 // degrees above the horizontal at the top of the frame
const VBOT = -9 // and below it at the bottom
const FAR = 6000 // metres. Past this the haze has swallowed everything anyway.
const EYE = 1.65

// Ray step. Fine near the eye where an angle changes fast, coarse far away --
// a constant step either misses near ridges or costs ten times what it needs to.
// Geometric growth keeps the ANGULAR resolution roughly constant, which is the
// thing that actually matters for a silhouette.
const STEP0 = 1.5
const GROW = 1.006

function skyline(name, ex, ez, facingDeg) {
  const eyeY = th.heightAt(ex, ez) + EYE
  // Per column: the elevation angle of the horizon, and the distance of whatever
  // drew it. The second one is what makes the haze layering possible.
  const horizon = new Float64Array(W)
  const hazeDist = new Float64Array(W)
  // Per pixel: distance of the nearest sample that covered it, or 0 for sky.
  const cover = new Float64Array(W * H).fill(Infinity)

  for (let c = 0; c < W; c++) {
    const az = ((facingDeg + (c / (W - 1) - 0.5) * FOV) * Math.PI) / 180
    const dx = Math.sin(az)
    const dz = Math.cos(az)
    let maxAng = -Infinity
    let d = 4
    let step = STEP0
    while (d < FAR) {
      const h = th.heightAt(ex + dx * d, ez + dz * d)
      const ang = Math.atan2(h - eyeY, d)
      if (ang > maxAng) {
        maxAng = ang
        // Paint every pixel this sample newly covers, from the previous skyline
        // down to the bottom of the frame, with THIS distance -- but only where
        // nothing nearer has painted already.
        const top = angToRow(maxAng)
        for (let r = Math.max(0, top); r < H; r++) {
          const i = r * W + c
          if (d < cover[i]) cover[i] = d
        }
        horizon[c] = maxAng
        hazeDist[c] = d
      }
      d += step
      step *= GROW
    }
  }

  const px = Buffer.alloc(W * H)
  for (let i = 0; i < W * H; i++) {
    if (cover[i] === Infinity) {
      // Sky: a soft vertical gradient so the silhouette reads against it.
      const r = Math.floor(i / W)
      px[i] = Math.round(198 + 42 * (1 - r / H))
    } else {
      // Exponential haze toward the sky value. 2.4 km e-folding is roughly what
      // the references show -- the third ridge back is already half dissolved.
      const f = 1 - Math.exp(-cover[i] / 2400)
      px[i] = Math.round(28 + (205 - 28) * f)
    }
  }
  const path = `${OUT}/${name}.png`
  writeGrayPng(path, W, H, px)

  // ---- the numbers ----
  const deg = (a) => (a * 180) / Math.PI
  const angs = Array.from(horizon, deg).sort((a, b) => a - b)
  const apex = angs[angs.length - 1]
  const med = angs[angs.length >> 1]
  // Distinct distance bands along the horizon, counted as sign changes in a
  // coarse quantisation of hazeDist -- how many separate ridgelines draw the sky.
  let layers = 0
  let prev = -1
  for (let c = 0; c < W; c++) {
    const band = Math.floor(Math.log2(Math.max(200, hazeDist[c]) / 200) * 1.5)
    if (band !== prev) layers++
    prev = band
  }
  console.log(
    `${path}  apex ${apex.toFixed(1)} deg  median ${med.toFixed(1)}  relief ${(apex - med).toFixed(1)} deg  bands ${layers}  eye ${eyeY.toFixed(0)} m`
  )
  return { apex, med, relief: apex - med }
}
const angToRow = (a) => Math.round(((VTOP - (a * 180) / Math.PI) / (VTOP - VBOT)) * H)

// Four viewpoints, deliberately not cherry-picked: the spawn, plus three points
// on a diagonal across the world, each looking at the nearest high ground.
const VIEWS = [
  ['sky-spawn', 0, 0, 0],
  ['sky-a', -4200, 3100, 45],
  ['sky-b', 2600, -5200, 200],
  ['sky-c', 5400, 4800, 290],
]
const all = []
for (const [n, x, z, f] of VIEWS) all.push(skyline(n, x, z, f))
const mean = (k) => all.reduce((s, v) => s + v[k], 0) / all.length
console.log(
  `\nMEAN  apex ${mean('apex').toFixed(1)} deg   relief ${mean('relief').toFixed(1)} deg   (references: apex 9-14, relief 5-9)`
)
