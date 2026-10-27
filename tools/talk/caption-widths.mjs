// Writes src/v2/talk/caption-em.js: each printable ASCII character's advance, in ems, the widest of the given
// TrueType fonts -- the faces the dialog caption may fall to (ui/dialog-panel.js SERIF). Talk text is ASCII, and
// talk/caption.js throws on any other character, so this table is the whole alphabet it may meet.
//   node tools/talk/caption-widths.mjs NotoSerif-Regular.ttf /System/Library/Fonts/Supplemental/Georgia.ttf ...
// Noto Serif (the Quest's serif) is at fonts.google.com; Georgia and Times New Roman ship with macOS.

import { readFileSync, writeFileSync } from 'node:fs'

/** Advance widths in ems for char codes 32..126 of the TrueType font in `buf`. */
function advances(buf) {
  const tables = {}
  for (let i = 0, n = buf.readUInt16BE(4); i < n; i++) {
    const at = 12 + i * 16
    tables[buf.toString('latin1', at, at + 4)] = buf.readUInt32BE(at + 8)
  }
  for (const t of ['head', 'hhea', 'hmtx', 'cmap']) if (tables[t] === undefined) throw new Error(`caption-widths: no ${t} table`)
  const em = buf.readUInt16BE(tables.head + 18)
  const metrics = buf.readUInt16BE(tables.hhea + 34)
  const cmap = tables.cmap
  let sub = null
  for (let i = 0, n = buf.readUInt16BE(cmap + 2); i < n; i++) {
    const at = cmap + 4 + i * 8
    if (buf.readUInt16BE(at) === 3 && buf.readUInt16BE(at + 2) === 1) sub = cmap + buf.readUInt32BE(at + 4)
  }
  if (sub === null || buf.readUInt16BE(sub) !== 4) throw new Error('caption-widths: no Windows BMP format-4 cmap')
  const segs = buf.readUInt16BE(sub + 6) / 2
  const ends = sub + 14, starts = ends + segs * 2 + 2, deltas = starts + segs * 2, offsets = deltas + segs * 2
  const glyph = (c) => {
    for (let s = 0; s < segs; s++) {
      if (buf.readUInt16BE(ends + s * 2) < c) continue
      const start = buf.readUInt16BE(starts + s * 2)
      if (start > c) return 0
      const off = buf.readUInt16BE(offsets + s * 2), delta = buf.readInt16BE(deltas + s * 2)
      if (off === 0) return (c + delta) & 0xffff
      const g = buf.readUInt16BE(offsets + s * 2 + off + (c - start) * 2)
      return g === 0 ? 0 : (g + delta) & 0xffff
    }
    return 0
  }
  const out = {}
  for (let c = 32; c < 127; c++) {
    const g = glyph(c)
    if (g === 0) throw new Error(`caption-widths: no glyph for ${JSON.stringify(String.fromCharCode(c))}`)
    out[String.fromCharCode(c)] = buf.readUInt16BE(tables.hmtx + Math.min(g, metrics - 1) * 4) / em
  }
  return out
}

const fonts = process.argv.slice(2)
if (fonts.length === 0) throw new Error('caption-widths: name the .ttf files to measure')
const widest = {}
for (const f of fonts) for (const [ch, w] of Object.entries(advances(readFileSync(f)))) widest[ch] = Math.max(widest[ch] ?? 0, Math.round(w * 1e4) / 1e4)
const out = new URL('../../src/v2/talk/caption-em.js', import.meta.url)
writeFileSync(out, `// Written by tools/talk/caption-widths.mjs from ${fonts.map((f) => f.split('/').pop()).join(', ')}.\nexport const EM = ${JSON.stringify(widest)}\n`)
console.log(`wrote ${out.pathname}: ${Object.keys(widest).length} characters, widest of ${fonts.length} fonts`)
