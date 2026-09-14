// ---------------------------------------------------------------------------
// A creature as two wing cards cut from its picked candidate image, for the
// roster's `rigType: 'none'` flyers: a butterfly's whole read is its wing
// pattern seen from above, which Tripo reconstructs badly and a photograph
// already has. The picked image (a top view on the plain grey cyclorama every
// candidate is prompted onto) is cut out along the creature's outline, boxed to
// one CARD_PX square RGBA map, and hung on two quads lying flat in XZ with a
// seam down the body axis -- one quad per wing, so a world placement can hinge
// each about z = 0. Four triangles, one 128px map, drawn double-sided.
//
// Pure: pixels in, GLB bytes out, no three, no filesystem. workspace.mjs feeds
// it the decoded image and files the result as a mesh candidate;
// scripts/check-wing-cards.mjs feeds it a synthetic one. The cut -- a fitted
// background, a shadow rule, a flood from the border, the largest component --
// is described at each function below and in design/27-creature-pipeline.md.
//
// The map is the creature's bounding box stretched to fill the whole square,
// NOT fitted inside it: the quads are sized from the box's own aspect, so a
// non-uniform stretch costs nothing and a 3:2 butterfly keeps every row of the
// 128 instead of leaving a third of them blank. Colour is dilated into the
// transparent margin (the same reason as src/props/impostor.js: bilinear
// filtering at the cutout's edge blends toward unwritten texels), and the PNG
// keeps those texels because it is written here from the raw bytes and never
// passes through a premultiplying canvas.
// ---------------------------------------------------------------------------

import zlib from 'node:zlib'

export const CARD_PX = 128
export const CHROMA_T = 20 // max(r,g,b) - min(r,g,b) at or above this is a coloured pixel, never grey background or its shadow
export const LUM_T = 24 // this far from the background model is foreground, whatever the hue
export const LUM_STRONG = 100 // this far is a dark outline or a pale patch, never a shadow
const EDGE_STRIP = 0.02 // the fraction of the width (and height) round the edge that fits the background model
const SUPERSAMPLE = 8 // sample points per texel side when boxing the box down to CARD_PX

const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b

function chroma(rgba, i) {
  const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
  return Math.max(r, g, b) - Math.min(r, g, b)
}

/**
 * The background's luminance as a quadratic in (x, y), least-squares fitted to
 * the ring of pixels round the image's edge. A cyclorama is lit with a vignette
 * -- this one runs 165 in the top corners to 190 at the top centre to 205 along
 * the bottom -- and a straight line per row misses the corners by more than
 * LUM_T, which sprays foreground specks across the top of the frame. The
 * quadratic holds the whole ring to within about four levels. Returns
 * bg(x, y), and throws on a ring that is not grey.
 */
function backgroundModel(rgba, W, H) {
  const strip = Math.max(2, Math.round(Math.min(W, H) * EDGE_STRIP))
  const terms = (x, y) => [1, x / W, y / H, (x / W) ** 2, (y / H) ** 2, (x / W) * (y / H)]
  const A = Array.from({ length: 6 }, () => new Float64Array(6))
  const B = new Float64Array(6)
  let odd = 0, n = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (x >= strip && x < W - strip && y >= strip && y < H - strip) continue
      const i = (y * W + x) * 4
      n++
      if (chroma(rgba, i) >= CHROMA_T) odd++
      const t = terms(x, y), l = lum(rgba[i], rgba[i + 1], rgba[i + 2])
      for (let r = 0; r < 6; r++) {
        B[r] += t[r] * l
        for (let c = 0; c < 6; c++) A[r][c] += t[r] * t[c]
      }
    }
  }
  if (odd > n * 0.02) throw new Error(`cutout: ${odd} coloured pixels in the image's edge ring -- the subject reaches the edge, or the background is not the plain grey the prompt asks for`)
  // Gaussian elimination with partial pivoting on the 6x6 normal equations.
  for (let i = 0; i < 6; i++) {
    let p = i
    for (let k = i + 1; k < 6; k++) if (Math.abs(A[k][i]) > Math.abs(A[p][i])) p = k
    ;[A[i], A[p]] = [A[p], A[i]]
    ;[B[i], B[p]] = [B[p], B[i]]
    for (let k = i + 1; k < 6; k++) {
      const f = A[k][i] / A[i][i]
      for (let j = i; j < 6; j++) A[k][j] -= f * A[i][j]
      B[k] -= f * B[i]
    }
  }
  const c = new Float64Array(6)
  for (let i = 5; i >= 0; i--) {
    let s = B[i]
    for (let j = i + 1; j < 6; j++) s -= A[i][j] * c[j]
    c[i] = s / A[i][i]
  }
  return (x, y) => terms(x, y).reduce((s, t, k) => s + t * c[k], 0)
}

/**
 * The creature's outline in `rgba` (row-major, W by H): a W*H mask of 0/255,
 * its bounding box (inclusive, one pixel of margin) and the mask's centre of
 * mass in x, which is where the body of a symmetric flyer is.
 *
 * Three classes of pixel against the background model: STRONG (coloured, or
 * LUM_STRONG off the grey -- the wing's veining, a black antenna, a chalk
 * patch), WEAK (LUM_T off -- fur, grey-brown scales, and also the soft cast
 * shadow the image model paints under the subject) and background. The shadow
 * is told from the creature by where it lies, not what colour it is, because
 * a shadow warmed by bounce off the wings is the same grey-tan as the abdomen:
 * a weak pixel DARKER than the background with no strong pixel anywhere
 * below it in its column is on the floor under the creature, so it is
 * background. Fur on the belly has the animal's outline below it; a shadow
 * has only floor. Then the flood and the largest component, as in the header.
 */
export function cutout(rgba, W, H) {
  if (rgba.length !== W * H * 4) throw new Error(`cutout: ${rgba.length} bytes is not ${W}x${H} RGBA`)
  const bg = backgroundModel(rgba, W, H)
  const fore = new Uint8Array(W * H) // 1 = weak, 2 = strong
  const below = new Int8Array(W * H) // -1 = a weak pixel darker than the background, awaiting the column test
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x, i = p * 4
      const d = lum(rgba[i], rgba[i + 1], rgba[i + 2]) - bg(x, y)
      if (chroma(rgba, i) >= CHROMA_T || Math.abs(d) >= LUM_STRONG) fore[p] = 2
      else if (Math.abs(d) >= LUM_T) {
        fore[p] = 1
        if (d < 0) below[p] = -1
      }
    }
  }
  let shadow = 0
  for (let x = 0; x < W; x++) {
    let anchored = false
    for (let y = H - 1; y >= 0; y--) {
      const p = y * W + x
      if (fore[p] === 2) anchored = true
      else if (below[p] === -1 && !anchored) { fore[p] = 0; shadow++ }
    }
  }

  // 0 = unvisited, 1 = background reached from the border, 2 = a foreground component, 3 = the creature.
  const label = new Uint8Array(W * H)
  const queue = new Int32Array(W * H)
  const flood = (start, passable, tag) => {
    let head = 0, tail = 0, count = 0
    for (const s of start) {
      if (label[s] || !passable(s)) continue
      label[s] = tag
      queue[tail++] = s
    }
    while (head < tail) {
      const p = queue[head++]
      count++
      const x = p % W, y = (p - x) / W
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1]) {
        if (q < 0 || label[q] || !passable(q)) continue
        label[q] = tag
        queue[tail++] = q
      }
    }
    return count
  }
  const border = []
  for (let x = 0; x < W; x++) border.push(x, (H - 1) * W + x)
  for (let y = 1; y < H - 1; y++) border.push(y * W, y * W + W - 1)
  flood(border, (p) => !fore[p], 1)

  // Everything the flood missed is a candidate component; the biggest is the creature.
  let best = -1, bestCount = 0
  const seeds = []
  for (let p = 0; p < W * H; p++) {
    if (label[p]) continue
    const count = flood([p], (q) => label[q] !== 1, 2)
    seeds.push({ p, count })
    if (count > bestCount) { best = seeds.length - 1; bestCount = count }
  }
  if (best < 0) throw new Error('cutout: nothing but background in the image')
  for (let p = 0; p < W * H; p++) if (label[p] === 2) label[p] = 0
  flood([seeds[best].p], (q) => label[q] !== 1, 3)

  const mask = new Uint8Array(W * H)
  let x0 = W, x1 = -1, y0 = H, y1 = -1, sumX = 0, n = 0
  for (let p = 0; p < W * H; p++) {
    if (label[p] !== 3) continue
    mask[p] = 255
    const x = p % W, y = (p - x) / W
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
    sumX += x
    n++
  }
  return {
    mask,
    box: { x0: Math.max(0, x0 - 1), x1: Math.min(W - 1, x1 + 1), y0: Math.max(0, y0 - 1), y1: Math.min(H - 1, y1 + 1) },
    centreX: sumX / n,
    pixels: n,
    shadow,
    dropped: seeds.length - 1,
  }
}

/**
 * The box `box` of `rgba` under `mask`, stretched to a CARD_PX square RGBA map:
 * each texel is the alpha-weighted mean of a SUPERSAMPLE grid of source
 * samples, its alpha the fraction of them inside the mask. Colour is then
 * dilated into every fully transparent texel from its opaque neighbours.
 */
export function cardTexture(rgba, W, mask, box) {
  const px = new Uint8Array(CARD_PX * CARD_PX * 4)
  const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1
  for (let ty = 0; ty < CARD_PX; ty++) {
    for (let tx = 0; tx < CARD_PX; tx++) {
      let r = 0, g = 0, b = 0, inside = 0
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const x = box.x0 + Math.min(bw - 1, Math.floor(((tx + (sx + 0.5) / SUPERSAMPLE) * bw) / CARD_PX))
          const y = box.y0 + Math.min(bh - 1, Math.floor(((ty + (sy + 0.5) / SUPERSAMPLE) * bh) / CARD_PX))
          const p = y * W + x
          if (!mask[p]) continue
          r += rgba[p * 4]
          g += rgba[p * 4 + 1]
          b += rgba[p * 4 + 2]
          inside++
        }
      }
      const i = (ty * CARD_PX + tx) * 4
      if (inside) {
        px[i] = r / inside
        px[i + 1] = g / inside
        px[i + 2] = b / inside
      }
      px[i + 3] = Math.round((255 * inside) / (SUPERSAMPLE * SUPERSAMPLE))
    }
  }
  dilate(px, CARD_PX, CARD_PX)
  return px
}

/** Fills every alpha-0 texel's colour from the mean of its written 8-neighbours, pass by pass, until none is left. */
export function dilate(px, w, h) {
  const written = new Uint8Array(w * h)
  let left = 0
  for (let p = 0; p < w * h; p++) {
    written[p] = px[p * 4 + 3] > 0 ? 1 : 0
    if (!written[p]) left++
  }
  if (left === w * h) throw new Error('dilate: the map is entirely transparent')
  while (left > 0) {
    const next = []
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x
        if (written[p]) continue
        let r = 0, g = 0, b = 0, n = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
            const q = yy * w + xx
            if (!written[q]) continue
            r += px[q * 4]
            g += px[q * 4 + 1]
            b += px[q * 4 + 2]
            n++
          }
        }
        if (n) next.push(p, r / n, g / n, b / n)
      }
    }
    for (let k = 0; k < next.length; k += 4) {
      const p = next[k]
      px[p * 4] = next[k + 1]
      px[p * 4 + 1] = next[k + 2]
      px[p * 4 + 2] = next[k + 3]
      written[p] = 1
      left--
    }
  }
}

// --- PNG ---------------------------------------------------------------------

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** `rgba` (row 0 at the top) as an 8-bit RGBA PNG. Row 0 stays the top, which is glTF's v = 0. */
export function encodePng(rgba, w, h) {
  if (rgba.length !== w * h * 4) throw new Error(`encodePng: ${rgba.length} bytes is not ${w}x${h} RGBA`)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0 // filter: none
    raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// --- the GLB -----------------------------------------------------------------

/**
 * Two quads flat in XZ wearing `png`, as the JSON and BIN chunks of a GLB.
 * The image's top is +X (the head, for a creature photographed head-up), its
 * right is +Z; the seam sits at z = 0 under image column `seamU` (0..1 across
 * the map), and the whole picture spans `widthM` across Z by `heightM` along X
 * with the box's centre at x = 0. Each wing has its own four vertices so a
 * placement can hinge either about the seam without touching the other.
 * Normals face +Y and the material is double-sided and alpha-masked at 0.5.
 */
export function wingCardsGlb(png, { widthM, heightM, seamU }) {
  if (!(widthM > 0 && heightM > 0)) throw new Error(`wingCardsGlb: bad card size ${widthM} x ${heightM}`)
  if (!(seamU > 0 && seamU < 1)) throw new Error(`wingCardsGlb: seam at u = ${seamU} leaves one wing empty`)
  const zL = -seamU * widthM, zR = (1 - seamU) * widthM, xTop = heightM / 2, xBot = -heightM / 2
  // Per wing: top-outer, top-seam, bottom-seam, bottom-outer, as (x, z, u, v).
  const wings = [
    [[xTop, zL, 0, 0], [xTop, 0, seamU, 0], [xBot, 0, seamU, 1], [xBot, zL, 0, 1]],
    [[xTop, 0, seamU, 0], [xTop, zR, 1, 0], [xBot, zR, 1, 1], [xBot, 0, seamU, 1]],
  ]
  const pos = [], nrm = [], uv = [], idx = []
  for (const [w, quad] of wings.entries()) {
    for (const [x, z, u, v] of quad) {
      pos.push(x, 0, z)
      nrm.push(0, 1, 0)
      uv.push(u, v)
    }
    const b = w * 4
    // Counter-clockwise seen from +Y: (b - a) x (c - a) must point up.
    idx.push(b, b + 2, b + 1, b, b + 3, b + 2)
  }
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]].map((i) => pos.slice(i * 3, i * 3 + 3))
    const ux = b[0] - a[0], uz = b[2] - a[2], vx = c[0] - a[0], vz = c[2] - a[2]
    if (uz * vx - ux * vz <= 0) throw new Error(`wingCardsGlb: triangle ${t / 3} winds away from +Y`)
  }

  const posBuf = Buffer.from(new Float32Array(pos).buffer)
  const nrmBuf = Buffer.from(new Float32Array(nrm).buffer)
  const uvBuf = Buffer.from(new Float32Array(uv).buffer)
  const idxBuf = Buffer.from(new Uint16Array(idx).buffer)
  const parts = [posBuf, nrmBuf, uvBuf, idxBuf, png]
  const bufferViews = []
  const chunks = []
  let off = 0
  for (const [i, p] of parts.entries()) {
    const view = { buffer: 0, byteOffset: off, byteLength: p.length }
    if (i === 3) view.target = 34963
    else if (i < 3) view.target = 34962
    bufferViews.push(view)
    const pad = (4 - (p.length % 4)) % 4
    chunks.push(p, Buffer.alloc(pad))
    off += p.length + pad
  }
  const xs = pos.filter((_, i) => i % 3 === 0), zs = pos.filter((_, i) => i % 3 === 2)
  const json = {
    asset: { version: '2.0', generator: 'aurora wing-cards' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'wing-cards', mesh: 0 }],
    meshes: [{ name: 'wing-cards', primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [Math.min(...xs), 0, Math.min(...zs)], max: [Math.max(...xs), 0, Math.max(...zs)] },
      { bufferView: 1, componentType: 5126, count: 8, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 8, type: 'VEC2' },
      { bufferView: 3, componentType: 5123, count: idx.length, type: 'SCALAR' },
    ],
    bufferViews,
    buffers: [{ byteLength: off }],
    images: [{ bufferView: 4, mimeType: 'image/png' }],
    textures: [{ source: 0 }],
    materials: [{
      name: 'wing-cards',
      pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 },
      alphaMode: 'MASK',
      alphaCutoff: 0.5,
      doubleSided: true,
      // Read by src/tripo-culling.js: a cutout card is the one creature material that must stay double-sided.
      extras: { cutout: true },
    }],
  }
  return { json, bin: Buffer.concat(chunks) }
}

/**
 * The whole job: the picked image's pixels to the card GLB's chunks, its
 * shipping map and a full-resolution cutout for the gallery. `sizeM` is the
 * creature's longest dimension, which is the box's longer side; `seamPx` nudges
 * the seam off the mask's centre of mass, in source pixels, for a creature
 * photographed a little askew.
 */
export function buildWingCards(rgba, W, H, { sizeM, seamPx = 0 }) {
  if (!(sizeM > 0)) throw new Error('buildWingCards: no sizeM -- the cards have no size to be cut at')
  const cut = cutout(rgba, W, H)
  const { box } = cut
  const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1
  const seamX = cut.centreX + seamPx
  const seamU = (seamX - box.x0) / bw
  const scale = sizeM / Math.max(bw, bh)
  const size = { widthM: bw * scale, heightM: bh * scale, seamU }
  const map = cardTexture(rgba, W, cut.mask, box)
  const png = encodePng(map, CARD_PX, CARD_PX)

  // The gallery's preview: the cut at source resolution, so a nick in the
  // outline is visible before the mesh is picked.
  const full = new Uint8Array(bw * bh * 4)
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const p = (box.y0 + y) * W + box.x0 + x, i = (y * bw + x) * 4
      full[i] = rgba[p * 4]
      full[i + 1] = rgba[p * 4 + 1]
      full[i + 2] = rgba[p * 4 + 2]
      full[i + 3] = cut.mask[p]
    }
  }
  return {
    ...wingCardsGlb(png, size),
    map,
    preview: encodePng(full, bw, bh),
    stats: { ...size, box, seamX, pixels: cut.pixels, shadow: cut.shadow, dropped: cut.dropped, tris: 4, texPx: CARD_PX },
  }
}
