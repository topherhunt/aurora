// ---------------------------------------------------------------------------
// Undo/redo as a bounded ring of whole-document snapshots.
//
// A command pattern -- an object per edit knowing how to invert itself -- is the
// textbook answer and it is the WRONG answer here, because §18's two-
// representation rule already bought the cheap one. The stored world is
// parametric and tiny: check-v2-edit.mjs measures an eight-object document (3
// snow points, 2 lakes, 2 six-point rivers, 1 road) at 710 BYTES of JSON. 64 of
// those is 45 kB, which is less memory than one chunk of terrain geometry, and
// even a hundred-object world stays under a megabyte of history. A snapshot also
// cannot go wrong the way an inverse operation
// can -- there is no "undo a lake resize" code path to get subtly asymmetric.
// The BAKED representation is the big one, and it is never snapshotted; it is
// rebuilt from the document, which is exactly what the epoch/dirty-rect
// machinery already does on every ordinary edit.
//
// Snapshots are stored as strings, not objects, so a later mutation of the live
// document cannot reach back and change a state already on the stack.
// ---------------------------------------------------------------------------

export class History {
  constructor(limit = 64) {
    if (!(limit >= 2)) throw new Error(`History: limit ${limit} leaves no room for a current state plus one undo`)
    this.limit = limit
    this.stack = []
    this.index = -1 // which entry of `stack` the world currently equals
  }

  get size() {
    return this.stack.length
  }

  get canUndo() {
    return this.index > 0
  }

  get canRedo() {
    return this.index >= 0 && this.index < this.stack.length - 1
  }

  /** Discard everything and take `snapshot` as the new origin. Load and boot. */
  reset(snapshot) {
    this.stack = [snapshot]
    this.index = 0
  }

  /**
   * Record a committed edit. Pushing after an undo BRANCHES: the redo tail is
   * dropped, because the future it described no longer follows from the present.
   */
  push(snapshot) {
    if (this.index < this.stack.length - 1) this.stack.length = this.index + 1
    this.stack.push(snapshot)
    // Drop from the front rather than refusing to record: losing the oldest
    // reachable state is a far smaller surprise than an edit that cannot be
    // undone at all.
    if (this.stack.length > this.limit) this.stack.shift()
    this.index = this.stack.length - 1
  }

  /** The previous state, or null when there is nothing behind the current one. */
  undo() {
    if (!this.canUndo) return null
    return this.stack[--this.index]
  }

  /** The next state, or null when nothing has been undone. */
  redo() {
    if (!this.canRedo) return null
    return this.stack[++this.index]
  }
}
