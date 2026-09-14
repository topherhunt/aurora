// Gate for tools/creatures/wing-cards.mjs: the picked candidate image cut out
// and laid on two textured quads.
//
//   node scripts/check-wing-cards.mjs
//
// Pure and free: a synthetic studio shot is drawn here -- a vignetted grey
// ground, two coloured wings, a dark body, a pale patch enclosed by a wing, a
// soft floor shadow under the wings and a speck in a corner -- and the cut is
// asserted against what was drawn. The failure modes it pins:
//
//   THE SHADOW IS CUT IN. The image prompt asks for no cast shadow and the
//   generator draws one anyway, a grey a few dozen levels darker than the
//   floor with the body's own warm tint in its core. Cut in, it ships as a
//   grey smear hanging under the hindwings.
//
//   THE VIGNETTE IS CUT IN. A flat background threshold reads the darker
//   corners as foreground, and the largest-component rule then either keeps a
//   corner or drops the butterfly.
//
//   A PALE SPOT IS A HOLE. A white eye-spot that matches the floor's grey is
//   only foreground because the wing encloses it.
//
//   THE PNG IS PREMULTIPLIED. The texture is written from raw bytes so the
//   colour under alpha 0 survives; a decode of the IDAT has to give the bytes
//   back exactly, including the dilated colour in transparent texels.
//
//   THE GLB IS SINGLE-SIDED OR BLENDED. The cards are one sheet each, drawn
//   from both sides with a hard alpha cut -- doubleSided, MASK, and the extras
//   flag src/tripo-culling.js keys its one exception on.

import zlib from 'node:zlib'
import {
  CARD_PX, buildWingCards, cardTexture, cutout, dilate, encodePng, wingCardsGlb,
} from '../tools/creatures/wing-cards.mjs'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}
const message = (fn) => { try { fn(); return '' } catch (e) { return e.message } }

// --- fixture ----------------------------------------------------------------

const W = 400, H = 300
const WING = [210, 140, 60], BODY = [70, 62, 55], SPECK = [40, 120, 200]
const bgAt = (x, y) => 200 - 30 * (((x - W / 2) / (W / 2)) ** 2 + ((y - H / 2) / (H / 2)) ** 2)
const inEllipse = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1

// Wings either side of x = 200, body 190..210 wide from y = 60 to 200, a
// pale patch inside the right wing at floor grey, a shadow band 20 px tall
// under the wings, a speck near the top-left corner.
const PATCH = { cx: 290, cy: 130, r: 12 }
const SHADOW = { y0: 205, y1: 225, x0: 110, x1: 300 }
function paint() {
  const rgba = new Uint8Array(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      let c = null
      const g = Math.round(bgAt(x, y))
      if (inEllipse(x, y, 120, 130, 80, 60) || inEllipse(x, y, 280, 130, 80, 60)) c = WING
      if (x >= 190 && x <= 210 && y >= 60 && y <= 200) c = BODY
      if (inEllipse(x, y, PATCH.cx, PATCH.cy, PATCH.r, PATCH.r)) c = [g, g, g]
      if (!c && y >= SHADOW.y0 && y <= SHADOW.y1 && x >= SHADOW.x0 && x <= SHADOW.x1) c = [g - 45, g - 45, g - 45]
      if (x >= 12 && x <= 14 && y >= 12 && y <= 14) c = SPECK
      rgba.set(c ?? [g, g, g], i)
      rgba[i + 3] = 255
    }
  }
  return rgba
}
const rgba = paint()
const at = (mask, x, y) => mask[y * W + x]

// --- cutout -----------------------------------------------------------------

const cut = cutout(rgba, W, H)
check(at(cut.mask, 120, 130) === 255 && at(cut.mask, 280, 130) === 255, 'both wings are foreground')
check(at(cut.mask, 200, 100) === 255, 'the body is foreground')
check(at(cut.mask, PATCH.cx, PATCH.cy) === 255, 'a floor-grey patch enclosed by a wing is filled in')
check(at(cut.mask, 200, 215) === 0 && at(cut.mask, 150, 215) === 0, 'the floor shadow under the wings is background', `shadow px removed: ${cut.shadow}`)
check(cut.shadow > 0, 'the shadow is counted', String(cut.shadow))
check(at(cut.mask, 13, 13) === 0 && cut.dropped >= 1, 'a corner speck is dropped as a minor component', `dropped: ${cut.dropped}`)
check(at(cut.mask, 5, 5) === 0 && at(cut.mask, W - 5, H - 5) === 0 && at(cut.mask, W / 2, 5) === 0, 'the vignetted corners and edges are background')
check(cut.box.x0 >= 38 && cut.box.x0 <= 41 && cut.box.x1 >= 359 && cut.box.x1 <= 362, 'the box hugs the wing tips with a 1 px margin', JSON.stringify(cut.box))
check(cut.box.y1 <= 201 + 1, 'the box stops at the body, not at the shadow', `y1 = ${cut.box.y1}`)
check(Math.abs(cut.centreX - 200) < 1, 'the centre of mass sits on the body', cut.centreX.toFixed(2))

const edged = paint()
for (let y = 0; y < H; y++) edged.set(WING, (y * W + 0) * 4)
check(/edge/.test(message(() => cutout(edged, W, H))), 'a subject touching the frame edge is refused, not cut')

// --- texture ----------------------------------------------------------------

const map = cardTexture(rgba, W, cut.mask, cut.box)
const texel = (x, y) => map.subarray((y * CARD_PX + x) * 4, (y * CARD_PX + x) * 4 + 4)
check(map.length === CARD_PX * CARD_PX * 4, `the map is ${CARD_PX}x${CARD_PX} RGBA`)
check(texel(64, 64)[3] === 255, 'the map is opaque at the body')
check(texel(0, 0)[3] === 0 && texel(CARD_PX - 1, CARD_PX - 1)[3] === 0, 'the map is transparent in the corners')
const bodyTexel = texel(64, 40)
check(Math.abs(bodyTexel[0] - BODY[0]) <= 8 && Math.abs(bodyTexel[2] - BODY[2]) <= 8, 'the body keeps its colour', Array.from(bodyTexel).join(','))
check(texel(0, 0)[0] > 0 || texel(0, 0)[1] > 0 || texel(0, 0)[2] > 0, 'transparent texels carry a dilated colour, not black')

const tiny = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
dilate(tiny, 2, 2)
check(tiny[4] === 255 && tiny[12] === 255 && tiny[7] === 0, 'dilate copies a neighbour colour into transparent texels and leaves alpha at 0')
check(/transparent/.test(message(() => dilate(new Uint8Array(16), 2, 2))), 'dilate refuses a fully transparent image')

// --- png --------------------------------------------------------------------

const png = encodePng(map, CARD_PX, CARD_PX)
function decodePng(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (!sig.every((b, i) => buf[i] === b)) throw new Error('bad signature')
  let off = 8, w = 0, h = 0
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('latin1', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4) }
    if (type === 'IDAT') idat.push(data)
    off += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    if (raw[y * (w * 4 + 1)] !== 0) throw new Error(`row ${y} uses filter ${raw[y * (w * 4 + 1)]}`)
    out.set(raw.subarray(y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1)), y * w * 4)
  }
  return { w, h, rgba: out }
}
const back = decodePng(Buffer.from(png))
check(back.w === CARD_PX && back.h === CARD_PX, 'the png declares the card size')
check(back.rgba.every((b, i) => b === map[i]), 'the png decodes back to the exact map bytes')

// --- glb --------------------------------------------------------------------

const { json, bin } = wingCardsGlb(png, { widthM: 0.06, heightM: 0.04, seamU: 0.5 })
const prim = json.meshes[0].primitives[0]
const mat = json.materials[prim.material]
check(json.accessors[prim.indices].count === 12, 'two quads, four triangles', String(json.accessors[prim.indices].count))
check(json.accessors[prim.attributes.POSITION].count === 8, 'eight vertices')
check(mat.doubleSided === true, 'the material is double-sided')
check(mat.alphaMode === 'MASK' && mat.alphaCutoff === 0.5, 'the material cuts alpha at 0.5')
check(mat.extras?.cutout === true, 'the material carries the cutout flag tripo-culling keys on')
check(json.images[0].mimeType === 'image/png' && json.bufferViews[json.images[0].bufferView].byteLength === png.length, 'the png is embedded whole')
const pmin = json.accessors[prim.attributes.POSITION].min, pmax = json.accessors[prim.attributes.POSITION].max
check(Math.abs(pmax[2] - pmin[2] - 0.06) < 1e-9 && Math.abs(pmax[0] - pmin[0] - 0.04) < 1e-9 && pmin[1] === 0 && pmax[1] === 0, 'the cards span width along z and height along x, flat in y', `${pmin} .. ${pmax}`)
check(json.buffers[0].byteLength === bin.length, 'the buffer length matches the bin chunk')
check(/wing empty/.test(message(() => wingCardsGlb(png, { widthM: 0.06, heightM: 0.04, seamU: 1 }))), 'a seam at the edge is refused')

// --- the whole build --------------------------------------------------------

const built = buildWingCards(rgba, W, H, { sizeM: 0.06 })
check(built.stats.tris === 4 && built.stats.texPx === CARD_PX, 'stats report 4 tris at the card size')
check(Math.abs(built.stats.widthM - 0.06) < 1e-9 && built.stats.heightM < built.stats.widthM, 'the longest side is sizeM', `${built.stats.widthM} x ${built.stats.heightM}`)
check(Math.abs(built.stats.seamU - 0.5) < 0.02, 'the seam sits at the body', built.stats.seamU.toFixed(3))
const nudged = buildWingCards(rgba, W, H, { sizeM: 0.06, seamPx: 32 })
check(Math.abs((nudged.stats.seamU - built.stats.seamU) * (cut.box.x1 - cut.box.x0 + 1) - 32) < 1e-6, 'seamPx moves the seam by that many source pixels')
const prev = decodePng(Buffer.from(built.preview))
check(prev.w === cut.box.x1 - cut.box.x0 + 1 && prev.h === cut.box.y1 - cut.box.y0 + 1, 'the preview is the cut at source resolution')
check(/sizeM/.test(message(() => buildWingCards(rgba, W, H, { sizeM: 0 }))), 'a creature without sizeM is refused')

console.log(failures ? `\n${failures} failure(s)` : '\nall wing-card checks passed')
process.exit(failures ? 1 : 0)
