// ---------------------------------------------------------------------------
// The room's creatures: what the creature layers owe the relay and what the
// relay tells them of everyone else's (server/src/main.js, "the creatures
// someone is interacting with"; _notes/creature-sync.md).
//
// OUT: every anchor a layer hands over through pending() -- this client the
// authority for an animal after her lure, and its final rejoin anchor -- and
// every lured set through pendingLured() -- which of a swarm bed's creatures
// her hand has -- goes to the relay as it is owed, one message each. With no
// relay open it is dropped: nothing is queued, since the next anchor or set
// a second on says everything this one did, and a rejoin the room never
// heard leaves the animal on its plan, which is where a room that never saw
// the lure has it.
//
// IN: the relay sends the anchors and lured sets written since this client
// last heard, the whole map on a welcome. Each goes to the layer whose key
// prefix it wears (a wildlife key is `st:tile:index`, a frog bed's `fg:tile`,
// say), an anchor at the room's clock. One stamped with this client's own id
// would be its own echoed back, and is dropped.
// ---------------------------------------------------------------------------

export class CreatureNet {
  /**
   * `netplay` the Netplay, `clock` the WorldClock, `layers` a list of
   * `{ layer, prefixes }`: a layer with pending(into) and apply(anchor, now)
   * or with pendingLured(into) and applyLured(set), and the first words of
   * the keys it owns.
   */
  constructor(netplay, clock, layers) {
    if (!netplay || typeof netplay.sendAnchor !== 'function') throw new Error('CreatureNet needs the Netplay')
    if (!clock || typeof clock.seconds !== 'number') throw new Error('CreatureNet needs the WorldClock')
    this.netplay = netplay
    this.clock = clock
    this.layers = []
    this.byPrefix = new Map()
    for (const entry of layers) this.add(entry.layer, entry.prefixes)
    this.out = []
    this.unknown = new Set()
    this.stats = { sent: 0, dropped: 0, heard: 0, luredSent: 0, luredHeard: 0 }
  }

  /** A layer joining after boot, once its keys' prefixes are known. */
  add(layer, prefixes) {
    const anchors = typeof layer?.pending === 'function' && typeof layer.apply === 'function'
    const lured = typeof layer?.pendingLured === 'function' && typeof layer.applyLured === 'function'
    if (!anchors && !lured) throw new Error('CreatureNet: a layer needs pending() and apply(), or pendingLured() and applyLured()')
    if (!Array.isArray(prefixes) || prefixes.length === 0) throw new Error('CreatureNet: a layer needs its key prefixes')
    for (const p of prefixes) {
      if (this.byPrefix.has(p)) throw new Error(`CreatureNet: prefix ${p} twice`)
      this.byPrefix.set(p, layer)
    }
    this.layers.push(layer)
  }

  /** After the layers have stepped this frame, so what they owe leaves now and what came in lands before the next step. */
  update() {
    const out = this.out
    out.length = 0
    for (const layer of this.layers) layer.pending?.(out)
    for (const anchor of out) {
      if (this.netplay.sendAnchor(anchor)) this.stats.sent++
      else this.stats.dropped++
    }
    out.length = 0
    for (const layer of this.layers) layer.pendingLured?.(out)
    for (const set of out) {
      if (this.netplay.sendLured(set)) this.stats.luredSent++
      else this.stats.dropped++
    }
    const blocks = this.netplay.creatures
    if (blocks.length === 0) return
    const now = this.clock.seconds
    const me = this.netplay.id
    for (const block of blocks) {
      for (const anchor of block.anchors ?? []) {
        if (!Array.isArray(anchor) || typeof anchor[0] !== 'string' || anchor[8] === me) continue
        const layer = this._layerFor(anchor[0])
        if (!layer?.apply) continue
        layer.apply(anchor, now)
        this.stats.heard++
      }
      for (const set of block.lured ?? []) {
        if (!Array.isArray(set) || typeof set[0] !== 'string' || set[2] === me) continue
        const layer = this._layerFor(set[0])
        if (!layer?.applyLured) continue
        layer.applyLured(set, now)
        this.stats.luredHeard++
      }
    }
    blocks.length = 0
  }

  /** The layer for a creature key, or null for one this build has no layer for -- a peer on a newer one -- said once a prefix. */
  _layerFor(key) {
    const prefix = key.slice(0, key.indexOf(':'))
    const layer = this.byPrefix.get(prefix)
    if (layer) return layer
    if (!this.unknown.has(prefix)) { this.unknown.add(prefix); console.warn(`[net] no creature layer for ${key}`) }
    return null
  }

  /** On leaving a room: what came in for it is not for the next. */
  dispose() {
    this.netplay.creatures.length = 0
    this.layers.length = 0
    this.byPrefix.clear()
  }
}
