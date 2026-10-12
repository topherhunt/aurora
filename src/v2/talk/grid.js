// The dialog grid (_notes/conversation-and-quests.md, "The dialog grid"): her sentence built a fragment at a time
// from a 4x4 of buttons. Cell 0 steps back a fragment; the rest are the fragments that may come next, the menu's
// chip paths (speak.js `menu`) read as a tree. A fragment that ends a path is punctuated and sends it. No preview of
// the sentence so far is shown. Three-free.

export const GRID = { cols: 4, rows: 4 }
const CELLS = GRID.cols * GRID.rows
const MORE = '...more'

export class DialogGrid {
  constructor() {
    this.path = []
    this.page = 0
  }

  reset() {
    this.path = []
    this.page = 0
  }

  /** The fragments that may follow the path so far, in menu order: `{ text, topic }`, `topic` set when it ends a sentence. */
  _next(menu) {
    const out = []
    const at = new Map()
    for (const chip of menu) {
      const p = chip.path
      if (p.length <= this.path.length || !this.path.every((f, i) => p[i] === f)) continue
      const text = p[this.path.length]
      const ends = p.length === this.path.length + 1
      if (!at.has(text)) {
        at.set(text, out.length)
        out.push({ text, topic: ends ? chip.topic : null })
      } else if (ends !== (out[at.get(text)].topic !== null)) throw new Error(`DialogGrid: "${[...this.path, text].join(' ')}" both ends a sentence and goes on`)
    }
    return out
  }

  /** The 16 cells for `menu`, row-major: `{ text, kind }`, kind 'back', 'stem', 'send', 'more' or 'empty'. */
  cells(menu) {
    const next = this._next(menu)
    // A page holds 15 fragments, or 14 and the way to the next page.
    const per = next.length > CELLS - 1 ? CELLS - 2 : CELLS - 1
    const pages = Math.ceil(next.length / per)
    if (this.page >= pages) this.page = 0
    const shown = next.slice(this.page * per, this.page * per + per)
    const cells = [{ text: '<', kind: this.path.length > 0 || this.page > 0 ? 'back' : 'empty' }]
    for (const f of shown) cells.push({ text: f.text, kind: f.topic !== null ? 'send' : 'stem', topic: f.topic })
    if (pages > 1) cells.push({ text: MORE, kind: 'more' })
    while (cells.length < CELLS) cells.push({ text: '', kind: 'empty' })
    return cells
  }

  /** Cell `i` pressed: the topic when it sends her sentence (the grid resets), else null. */
  press(menu, i) {
    const cell = this.cells(menu)[i]
    if (cell.kind === 'back') this.back()
    else if (cell.kind === 'more') this.page++
    else if (cell.kind === 'stem') {
      this.path.push(cell.text)
      this.page = 0
    } else if (cell.kind === 'send') {
      this.reset()
      return cell.topic
    }
    return null
  }

  back() {
    if (this.page > 0) this.page--
    else this.path.pop()
  }
}
