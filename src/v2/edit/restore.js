// ---------------------------------------------------------------------------
// Put a serialised document back into a LIVE `Layers` instance.
//
// `Layers.deserialize(json)` returns a NEW Layers, and that is the wrong shape
// for undo, load and import: `V2Height`, the mesher, the marker layer and this
// editor all hold a reference to the one instance, and handing out a second one
// would leave every consumer pointed at the old world with no way to tell. So
// undo replays the snapshot THROUGH the mutation API onto the instance everyone
// already holds -- every bake, every dirty rect and every epoch bump happens the
// way it does for a hand edit, because it IS the same code path.
//
// It is O(objects), not O(1), and that is fine: the document holds a couple of
// dozen authored objects by construction (§18's whole point), and an undo is a
// keypress, not a frame. The alternative -- a `Layers.load(json)` that rebakes
// everything at once -- would be faster and is not on the contract this file
// codes against.
//
// TWO PLACES THIS REACHES PAST THE MUTATION API, both deliberate and both worth
// knowing about if `layers.js` changes underneath:
//
//   `doc.snow.base` / `doc.snow.band` have no setter. They are query-time
//   scalars -- §18's interpolant is `snowLine = base + delta(p)` and only the
//   DELTA grid is baked -- so writing them onto the live doc needs no rebake. If
//   base ever gets folded into the baked grid, this is what breaks.
//
//   Ids are written back after re-adding. `addLake`/`addPath` mint fresh ids, so
//   a naive replay would renumber the whole world on every undo -- the panel's
//   selection would drop, and the committed `layers.json` would show every
//   object as changed in a diff. An id is a label, not an index, so putting the
//   old one back is safe and is what keeps undo invisible.
// ---------------------------------------------------------------------------

function byId(items, id) {
  const rec = items.find((it) => it.id === id)
  if (!rec) throw new Error(`restoreLayers: layer add returned id ${id} but no such record exists`)
  return rec
}

/**
 * Make `layers` hold exactly the world described by `json` (the output of
 * `layers.serialize()`), mutating in place.
 */
export function restoreLayers(layers, json) {
  if (!json || !json.snow || !Array.isArray(json.lakes) || !Array.isArray(json.rivers) || !Array.isArray(json.roads)) {
    throw new Error('restoreLayers: not a v2 world document (needs snow, lakes, rivers, roads)')
  }

  for (let i = layers.snow.points.length - 1; i >= 0; i--) layers.removeSnowPoint(i)
  layers.doc.snow.base = json.snow.base
  layers.doc.snow.band = json.snow.band
  for (const [x, z, delta, radius] of json.snow.points) layers.addSnowPoint(x, z, delta, radius)

  for (const item of layers.lakes.items.slice()) layers.removeLake(item.id)
  for (const l of json.lakes) {
    const id = layers.addLake({
      x: l.x, z: l.z, y: l.y, rx: l.rx, rz: l.rz, rot: l.rot, shape: l.shape, carve: l.carve, depth: l.depth,
    })
    byId(layers.lakes.items, id).id = l.id
  }

  for (const item of layers.paths.items.slice()) layers.removePath(item.id)
  for (const [kind, list] of [['river', json.rivers], ['road', json.roads]]) {
    for (const p of list) {
      const id = layers.addPath(kind, p.pts.map((q) => q.slice()))
      const rec = byId(layers.paths.items, id)
      rec.id = p.id
      if (p.depth !== undefined) rec.depth = p.depth
      if (p.feather !== undefined) rec.feather = p.feather
    }
  }
}

/**
 * An empty v2 world -- what boot falls back to when nothing has been authored.
 *
 * `base` and `band` ARE ARGUMENTS, and refusing to default them is deliberate.
 * They are metres above sea level, and the draft of this file carried 148 / 47
 * because that was three quarters of the way up v1's -0.82..319.49 m procedural
 * field. v2's coarse shape is now an imported 8-bit JPEG that carries no metres
 * at all: its vertical range is decided at bake time and written into
 * world/height.json. A default here would be a snow line pinned to a world that
 * no longer exists -- either under every summit or over all of them -- and it
 * would look like a working default rather than a stale one. So the caller reads
 * the loaded heightmap's own min/max and says. A conventional choice is three
 * quarters of the relief, with a band of about an eighth.
 */
export function emptyDoc(base, band) {
  if (!Number.isFinite(base) || !Number.isFinite(band)) {
    throw new Error(`emptyDoc(base, band): both are metres and both are required, got ${base} and ${band}. Derive them from the loaded heightmap's min/max -- see the comment.`)
  }
  return { v: 1, snow: { base, band, points: [] }, lakes: [], rivers: [], roads: [] }
}
