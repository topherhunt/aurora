// Pre-baked card photographs. captureLayer (impostor.js) and bakeCritterCard
// (v2/render/critters.js) look up the bytes they are about to render by a hash
// of what they photograph, and a production build loads those bytes from
// /cards.bin, which scripts/bake-cards.mjs writes into dist at deploy by booting
// that same build with ?bakecards. A miss bakes live and is counted in the boot
// report. THE HASH COVERS THE SUBJECT, CAMERA AND LIGHT, NOT THE SHADERS OR THE
// ATLAS IT SAMPLES: a file baked by an older build would serve stale pictures
// without a single miss, so it is only ever valid for the build it was baked from.

const baked = new Map()
const recorded = new Map()
const stats = { baked: 0, live: 0 }
// 'off' bakes everything live and hashes nothing (dev), 'use' serves the file, 'record' collects for the deploy's bake.
let mode = 'off'

/** Serve the cards packed at `url` (gzip of packCards' layout). Rejects on a missing or unreadable file; the mode stays 'use' so every card then counts as live. */
export async function loadBakedCards(url) {
  mode = 'use'
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} answered ${res.status}`)
  const buf = new Uint8Array(await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
  const head = new DataView(buf.buffer).getUint32(0, true)
  let at = 4 + head
  for (const [key, length] of JSON.parse(new TextDecoder().decode(buf.subarray(4, at)))) {
    baked.set(key, buf.subarray(at, at + length))
    at += length
  }
  if (at !== buf.length) throw new Error(`${url} is ${buf.length} bytes but its index covers ${at}`)
  return baked.size
}

export function recordCards() {
  mode = 'record'
}

export const cardsOn = () => mode !== 'off'

/** A copy of the pre-baked bytes for `key`, or null: bake live, then `keepCard` the result. */
export function bakedCard(key) {
  const px = baked.get(key)
  if (px) {
    stats.baked++
    return px.slice()
  }
  stats.live++
  return null
}

/** A live bake's bytes. Kept only while recording; the last bake of a key wins, as it would at runtime. */
export function keepCard(key, px) {
  if (mode === 'record') recorded.set(key, px.slice())
}

export const cardStats = () => ({ mode, ...stats, recorded: recorded.size })

/** The recorded cards as one buffer: a u32 index length, the JSON index [[key, bytes], ...], then each card's bytes in index order. */
export function packCards() {
  const index = new TextEncoder().encode(JSON.stringify([...recorded].map(([k, px]) => [k, px.length])))
  const out = new Uint8Array(4 + index.length + [...recorded.values()].reduce((s, px) => s + px.length, 0))
  new DataView(out.buffer).setUint32(0, index.length, true)
  out.set(index, 4)
  let at = 4 + index.length
  for (const px of recorded.values()) {
    out.set(px, at)
    at += px.length
  }
  return out
}

/** Two independent 32-bit multiply-xor lanes over whatever is fed in; `key` is their 16 hex digits. */
export class CardHash {
  a = 0x811c9dc5
  b = 0x9e3779b9

  words(u32) {
    let { a, b } = this
    for (let i = 0; i < u32.length; i++) {
      const w = u32[i]
      a = Math.imul(a ^ w, 0x01000193)
      b = Math.imul(b ^ w, 0x5bd1e995)
      b ^= b >>> 13
    }
    this.a = a
    this.b = b
    return this
  }

  bytes(arr) {
    const aligned = arr.byteOffset % 4 === 0 && arr.byteLength % 4 === 0
    return this.words(aligned ? new Uint32Array(arr.buffer, arr.byteOffset, arr.byteLength / 4)
      : Uint32Array.from(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)))
  }

  nums(xs) {
    return this.bytes(Float64Array.from(xs))
  }

  text(s) {
    return this.words(Uint32Array.from(s, (c) => c.charCodeAt(0)))
  }

  /** Every attribute by name (an interleaved one feeds its whole shared buffer), the index and the draw range. */
  geometry(g) {
    for (const name of Object.keys(g.attributes).sort()) {
      const attr = g.attributes[name]
      this.text(name).nums([attr.itemSize, attr.isInterleavedBufferAttribute ? attr.offset : 0])
      this.bytes(attr.isInterleavedBufferAttribute ? attr.data.array : attr.array)
    }
    if (g.index) this.bytes(g.index.array)
    return this.nums([g.drawRange.start, Number.isFinite(g.drawRange.count) ? g.drawRange.count : -1])
  }

  get key() {
    return (this.a >>> 0).toString(16).padStart(8, '0') + (this.b >>> 0).toString(16).padStart(8, '0')
  }
}
