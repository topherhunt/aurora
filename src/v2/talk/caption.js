// The dialog caption's room for a line (ui/dialog-panel.js draws it), and how many rows a line takes there, measured in
// the widest advances of the fonts it may fall to (caption-em.js). Kerning only narrows text, so this errs long. The
// talk adds a lead-in, an aside or a rumour only while the line still `fits`; check-talk walks every line against it.
// Three-free.
import { EM } from './caption-em.js'

// Px on the caption canvas: `width` across, `rows` lines of `px` text from `top`, `step` apart, `inset` from each side.
export const CAPTION = { width: 747, px: 26, rows: 3, top: 50, step: 32, inset: 16 }

/** Words `text` broken into lines no wider than `w` px, by `measure` (a canvas context or `widest`). */
export function wrap(measure, text, w) {
  const lines = []
  let line = ''
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word
    if (line && measure.measureText(next).width > w) {
      lines.push(line)
      line = word
    } else line = next
  }
  if (line) lines.push(line)
  return lines
}

/** Measures caption text at CAPTION.px in the widest of its fonts, as a canvas context would. */
export const widest = {
  measureText(s) {
    let w = 0
    for (const ch of s) {
      if (EM[ch] === undefined) throw new Error(`caption: no width for ${JSON.stringify(ch)} in ${JSON.stringify(s)}`)
      w += EM[ch] * CAPTION.px
    }
    return { width: w }
  },
}

/** Rows `text` takes in the caption. */
export const captionRows = (text) => wrap(widest, text, CAPTION.width - 2 * CAPTION.inset).length

/** Whether `text` fits the caption's rows. */
export const fits = (text) => captionRows(text) <= CAPTION.rows
