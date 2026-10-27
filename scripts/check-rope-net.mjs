// Gate for the scaffold nets' texture (scripts/gen-rope-net.mjs, public/gen-props/rope-net.png): the shipped PNG is what the generator makes, tiles without a seam on both axes, and is a net -- rope with knots at the crossings and clear holes between.
//
//   node scripts/check-rope-net.mjs
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { ROPE_NET, ROPE_NET_PNG, ropeNet, ropeNetPng } from './gen-rope-net.mjs'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}

const { size, cells, knot, half } = ROPE_NET
const file = readFileSync(ROPE_NET_PNG)
check(Buffer.compare(file, ropeNetPng()) === 0, 'the shipped PNG is byte for byte what gen-rope-net.mjs writes', `${file.length} bytes`)
check(Buffer.compare(ropeNetPng(), ropeNetPng()) === 0, 'two generations are identical')

// Decode the shipped file itself: IHDR, one IDAT of filter-0 rows.
const width = file.readUInt32BE(16), height = file.readUInt32BE(20)
check(width === 256 && height === 256 && file[24] === 8 && file[25] === 6, 'it is a 256 x 256 8-bit RGBA PNG', `${width} x ${height}, depth ${file[24]}, type ${file[25]}`)
const raw = inflateSync(file.subarray(file.indexOf('IDAT') + 4, file.lastIndexOf('IEND') - 8))
const px = new Uint8Array(width * height * 4)
for (let y = 0; y < height; y++) {
  if (raw[y * (width * 4 + 1)] !== 0) throw new Error(`row ${y} uses a PNG filter this gate does not decode`)
  px.set(raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4)
}
const want = ropeNet()
check(px.every((v, i) => v === want[i]), 'the decoded pixels are the generator\'s')

const at = (x, y, c) => px[(((y + height) % height) * width + ((x + width) % width)) * 4 + c]
// Seamless: the step across the wrap is no bigger than the largest step inside the image, in every channel and on both axes.
for (const [axis, dx, dy] of [['x', 1, 0], ['y', 0, 1]]) {
  for (let c = 0; c < 4; c++) {
    let inner = 0, seam = 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const d = Math.abs(at(x, y, c) - at(x + dx, y + dy, c))
        const wraps = axis === 'x' ? x === width - 1 : y === height - 1
        if (wraps) seam = Math.max(seam, d)
        else inner = Math.max(inner, d)
      }
    }
    check(seam <= inner, `the ${axis} wrap of channel ${c} is no harder an edge than the inside`, `seam ${seam}, inside ${inner}`)
  }
}

// A net: holes are the larger part, the rope is solid, the knots are on the crossings and the strands run on the mesh lines.
let clear = 0, solid = 0
for (let i = 3; i < px.length; i += 4) {
  if (px[i] === 0) clear++
  else if (px[i] === 255) solid++
}
const total = width * height
check(clear / total > 0.5 && clear / total < 0.85, 'the holes are 50-85% of the picture', `${((100 * clear) / total).toFixed(0)}%`)
check(solid / total > 0.1, 'the rope is solid over more than a tenth of it', `${((100 * solid) / total).toFixed(0)}%`)
const pitch = size / cells
let crossings = 0, centres = 0, mids = 0
for (let i = 0; i < cells; i++) {
  for (let j = 0; j < cells; j++) {
    crossings++
    if (at(i * pitch, j * pitch, 3) === 255 && at(i * pitch + knot - 2, j * pitch, 3) === 255) centres++
    if (at(i * pitch + pitch / 2, j * pitch + pitch / 2, 3) === 0) mids++
  }
}
check(centres === crossings, 'every crossing carries a knot wider than the rope', `${centres}/${crossings}`)
check(mids === crossings, 'the middle of every mesh is a clear hole', `${mids}/${crossings}`)
check(at(pitch / 2, 0, 3) === 255 && at(pitch / 2, Math.floor(half) - 1, 3) === 255 && at(pitch / 2, Math.ceil(half) + 2, 3) === 0, 'a strand runs along each mesh line and not between them')
// The twist: along a strand the shade varies in a period of ROPE_NET.twist.
const along = []
for (let x = 20; x < 20 + ROPE_NET.twist * 2; x++) along.push(at(x, 0, 0))
check(Math.max(...along) - Math.min(...along) > 30, 'the rope is twisted, its shade varying along the strand', `range ${Math.max(...along) - Math.min(...along)}`)

console.log(failures === 0 ? '\nrope net: all ok' : `\nrope net: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
