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
// keypress, not a frame. A `Layers.load(json)` that rebaked once instead of per
// object would be faster and does not exist; if it appears, this file should
// become a call to it.
//
// IDS ARE CARRIED, not reallocated. `Layers.addLake` and `Layers.addPath` both
// honour an id already on the record and hand it to `IdAllocator.observe`, so a
// replay keeps every object's name. That matters twice over: the panel's
// selection and the undo stack key on a bare id string, and the committed
// `layers.json` would otherwise show every object as changed in a git diff after
// any undo.
//
// THE ONE PLACE THIS REACHES PAST THE MUTATION API is `snow.band`, which has no
// setter -- `setSnowBase` exists, `setSnowBand` does not. Band is a query-time
// scalar (§18's shading reads `base` and `band`; only the DELTA grid is baked),
// so writing it needs no rebake, and it is written BEFORE `setSnowBase`, whose
// commit marks the whole world dirty and covers both. If band is ever folded
// into a baked grid, this is what breaks.
// ---------------------------------------------------------------------------

/**
 * Make `layers` hold exactly the world described by `json` (the output of
 * `layers.serialize()`), mutating in place.
 */
export function restoreLayers(layers, json) {
  if (!json || !json.snow || !Array.isArray(json.lakes) || !Array.isArray(json.rivers) || !Array.isArray(json.roads)) {
    throw new Error('restoreLayers: not a v2 world document (needs snow, lakes, rivers, roads)')
  }

  // Find-first-then-remove rather than a countdown over the array: removal
  // tombstones today (see handles.js), so `points.length` keeps counting the
  // holes and a countdown would walk off into them.
  for (;;) {
    const i = layers.snow.points.findIndex((p) => p !== null)
    if (i === -1) break
    layers.removeSnowPoint(i)
  }
  layers.snow.band = json.snow.band
  layers.setSnowBase(json.snow.base)
  for (const [x, z, delta, radius] of json.snow.points) layers.addSnowPoint(x, z, delta, radius)

  for (const id of [...layers.lakes.lakes.keys()]) layers.removeLake(id)
  for (const l of json.lakes) layers.addLake({ ...l })

  for (const id of [...layers.paths.paths.keys()]) layers.removePath(id)
  for (const [kind, list] of [['river', json.rivers], ['road', json.roads]]) {
    for (const p of list) layers.addPath({ ...p, kind, pts: p.pts.map((q) => q.slice()) })
  }
}

/**
 * An empty v2 world -- what boot falls back to when nothing has been authored.
 *
 * `base` and `band` ARE ARGUMENTS, and refusing to default them is deliberate.
 * They are metres above sea level, and doc.js's own defaults (148 / 47) carry a
 * comment saying they are PROVISIONAL: they came from v1's -0.82..319.49 m
 * procedural field, and v2's coarse shape is now an imported 8-bit JPEG that
 * carries no metres at all, whose vertical range is decided at bake time and
 * written into world/height.json. A default here would be a snow line pinned to
 * a world that no longer exists -- either under every summit or over all of them
 * -- and it would look like a working default rather than a stale one. So the
 * caller reads the loaded heightmap's own min/max and says. A conventional
 * choice is three quarters of the relief, with a band of about an eighth.
 */
export function emptyDoc(base, band) {
  if (!Number.isFinite(base) || !Number.isFinite(band)) {
    throw new Error(`emptyDoc(base, band): both are metres and both are required, got ${base} and ${band}. Derive them from the loaded heightmap's min/max -- see the comment.`)
  }
  if (!(band > 0)) throw new Error(`emptyDoc: band must be > 0 metres, got ${band}`)
  return { v: 1, snow: { base, band, points: [] }, lakes: [], rivers: [], roads: [] }
}
