// ---------------------------------------------------------------------------
// WorldDoc: the STORED representation of the v2 world (DESIGN.md §18).
//
// Three-free, and pure functions only -- nothing here holds state, because the same schema has to be readable by the editor, by the node gate and by a worker that only ever sees a postMessage copy.
//
// The whole authored world is a few kilobytes of JSON: diffable in git, hand-editable in a text editor, cheap enough to ship to a worker on every commit. That is only true because anything there are many of is an array of NUMBERS and not an array of objects -- a snow point is [x, z, delta, radius] and not {"x":..,"z":..,"delta":..,"radius":..}, which is the difference between 24 bytes and 60 for the identical information.
//
// validate() THROWS and names the offending path. It does not coerce, default or repair: a document that has been through a bad export or a hand edit with a typo must fail at load with "snow.points[3][2] is not a finite number", because the alternative is a silently zeroed field and a world that is subtly wrong in a way nobody can trace back to the file.
// ---------------------------------------------------------------------------

export const DOC_VERSION = 1

// The snow line of an unedited world. Both are read by the mesher's shading and by the props, so they live in the document rather than in a module constant -- an author moving the snow line is an edit, not a code change.
//
// THESE ARE THE FALLBACK, NOT THE ANSWER. A snow line is an elevation, and an elevation only means something against a particular bake: these two came from v1's procedural field (range -0.82 to 319.49 m) and on the current 0..900 m import they land at the 12th percentile, which is seven eighths of the world under snow. The browser derives its own from the loaded image instead -- snowDefaults() below, which reads 582.7 m +/- 106.1 m off the bake now on disk and puts a quarter of the world white.
//
// What is left here is what a document needs when there is no heightmap in the room at all, which is every node gate: they construct worlds to test the interpolant's SHAPE (exact at its points, exactly base outside every radius, smooth between) and none of them cares what the elevation is. That is also why nothing asserts these numbers.
export const DEFAULT_SNOW_BASE = 148
export const DEFAULT_SNOW_BAND = 47

// The snow line the BROWSER starts a fresh world with, derived from the loaded image instead of written down: p75 for the base, so a quarter of the world is white, and half the p50..p90 spread for the band, so the soft edge is proportional to how spread out the relief actually is. `bands` is V2Height.bands.
//
// It lives here, next to the fallback it supersedes, so the node gates can assert against the number the browser will really use. Re-baking the heightmap with a different --maxY moves every one of these percentiles and an assertion against a literal would be checking last week's world.
export function snowDefaults(bands) {
  for (const k of ['p50', 'p75', 'p90']) {
    if (typeof bands?.[k] !== 'number' || !Number.isFinite(bands[k])) throw new Error(`snowDefaults: bands.${k} must be a finite number, got ${bands?.[k]}`)
  }
  return { base: bands.p75, band: Math.max(10, (bands.p90 - bands.p50) / 2) }
}

export function defaultDoc() {
  return {
    v: DOC_VERSION,
    snow: { base: DEFAULT_SNOW_BASE, band: DEFAULT_SNOW_BAND, points: [] },
    lakes: [],
    rivers: [],
    roads: [],
  }
}

function fail(path, what, got) {
  throw new Error(`world doc: ${path} ${what}, got ${JSON.stringify(got)}`)
}

function num(v, path) {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, 'must be a finite number', v)
  return v
}

function positive(v, path) {
  num(v, path)
  if (v <= 0) fail(path, 'must be > 0', v)
  return v
}

function nonNegative(v, path) {
  num(v, path)
  if (v < 0) fail(path, 'must be >= 0', v)
  return v
}

function array(v, path) {
  if (!Array.isArray(v)) fail(path, 'must be an array', v)
  return v
}

function id(v, path, seen) {
  if (typeof v !== 'string' || v.length === 0) fail(path, 'must be a non-empty string', v)
  if (seen.has(v)) fail(path, `duplicates an id already used in this document (${v})`, v)
  seen.add(v)
  return v
}

// Road control points: [x, y, z, width], authored in 3D.
function roadPoints(v, path) {
  array(v, path)
  if (v.length === 0) fail(path, 'must have at least one control point', v)
  for (let i = 0; i < v.length; i++) {
    const p = v[i]
    if (!Array.isArray(p) || p.length !== 4) fail(`${path}[${i}]`, 'must be [x, y, z, width]', p)
    num(p[0], `${path}[${i}][0]`)
    num(p[1], `${path}[${i}][1]`)
    num(p[2], `${path}[${i}][2]`)
    positive(p[3], `${path}[${i}][3]`)
  }
  return v
}

// River nodes: [x, z] or [x, z, width]. No y -- the water level is solved from the terrain -- and the width is optional per node, interpolated from the nodes that carry one, so at least one must.
function riverPoints(v, path) {
  array(v, path)
  if (v.length === 0) fail(path, 'must have at least one control point', v)
  let widths = 0
  for (let i = 0; i < v.length; i++) {
    const p = v[i]
    if (!Array.isArray(p) || (p.length !== 2 && p.length !== 3)) fail(`${path}[${i}]`, 'must be [x, z] or [x, z, width]', p)
    num(p[0], `${path}[${i}][0]`)
    num(p[1], `${path}[${i}][1]`)
    if (p.length === 3) {
      positive(p[2], `${path}[${i}][2]`)
      widths++
    }
  }
  if (widths === 0) fail(path, 'must set a width on at least one node', v)
  return v
}

// Throws on the first problem, naming its path. Returns the document so `const doc = validate(JSON.parse(text))` reads as one step.
export function validate(json) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) fail('root', 'must be an object', json)
  if (json.v !== DOC_VERSION) fail('v', `must be ${DOC_VERSION}`, json.v)

  const snow = json.snow
  if (snow === null || typeof snow !== 'object' || Array.isArray(snow)) fail('snow', 'must be an object', snow)
  num(snow.base, 'snow.base')
  positive(snow.band, 'snow.band')
  array(snow.points, 'snow.points')
  for (let i = 0; i < snow.points.length; i++) {
    const p = snow.points[i]
    if (!Array.isArray(p) || p.length !== 4) fail(`snow.points[${i}]`, 'must be [x, z, delta, radius]', p)
    num(p[0], `snow.points[${i}][0]`)
    num(p[1], `snow.points[${i}][1]`)
    num(p[2], `snow.points[${i}][2]`)
    positive(p[3], `snow.points[${i}][3]`)
  }

  // One id space across all three lists, because the editor's selection, the layer panel and the undo stack all key on a bare id string and cannot tell an 'l' from an 'r' without looking it up.
  const seen = new Set()

  array(json.lakes, 'lakes')
  for (let i = 0; i < json.lakes.length; i++) {
    const l = json.lakes[i]
    if (l === null || typeof l !== 'object' || Array.isArray(l)) fail(`lakes[${i}]`, 'must be an object', l)
    id(l.id, `lakes[${i}].id`, seen)
    num(l.x, `lakes[${i}].x`)
    num(l.z, `lakes[${i}].z`)
    num(l.y, `lakes[${i}].y`)
    positive(l.rx, `lakes[${i}].rx`)
    positive(l.rz, `lakes[${i}].rz`)
    if (l.rot !== undefined) num(l.rot, `lakes[${i}].rot`)
    if (l.shape !== undefined && l.shape !== 0 && l.shape !== 1) fail(`lakes[${i}].shape`, 'must be 0 (ellipse) or 1 (rectangle)', l.shape)
    if (l.carve !== undefined && l.carve !== 0 && l.carve !== 1 && typeof l.carve !== 'boolean') fail(`lakes[${i}].carve`, 'must be 0, 1 or a boolean', l.carve)
    if (l.depth !== undefined) positive(l.depth, `lakes[${i}].depth`)
  }

  array(json.rivers, 'rivers')
  for (let i = 0; i < json.rivers.length; i++) {
    const r = json.rivers[i]
    if (r === null || typeof r !== 'object' || Array.isArray(r)) fail(`rivers[${i}]`, 'must be an object', r)
    id(r.id, `rivers[${i}].id`, seen)
    if (r.depth !== undefined) nonNegative(r.depth, `rivers[${i}].depth`)
    riverPoints(r.pts, `rivers[${i}].pts`)
  }

  array(json.roads, 'roads')
  for (let i = 0; i < json.roads.length; i++) {
    const d = json.roads[i]
    if (d === null || typeof d !== 'object' || Array.isArray(d)) fail(`roads[${i}]`, 'must be an object', d)
    id(d.id, `roads[${i}].id`, seen)
    if (d.feather !== undefined) nonNegative(d.feather, `roads[${i}].feather`)
    roadPoints(d.pts, `roads[${i}].pts`)
  }

  return json
}

// A road the world generates at boot (the towns, layers/towns.js) rather than one authored in the editor. It rides every document the terrain workers and the undo stack see, and never one that is saved: the generator puts it back on the next boot, and a saved copy would stack a second one under it.
export const GENERATED_ID = /^town\d/
export const isGenerated = (id) => GENERATED_ID.test(id)

// Build the document from a live Layers. Each sub-layer knows its own compact form; this only assembles them, so there is exactly one place that decides what a lake looks like on disk. `authored` drops the generated roads -- what a save writes.
export function serialize(layers, { authored = false } = {}) {
  const roads = layers.paths.toJSON('road')
  return {
    v: DOC_VERSION,
    snow: layers.snow.toJSON(),
    lakes: layers.lakes.toJSON(),
    rivers: layers.paths.toJSON('river'),
    roads: authored ? roads.filter((r) => !isGenerated(r.id)) : roads,
  }
}

// Stable id allocation: l1, l2 for lakes, r1 for rivers, d1 for roads.
//
// Seeded from the document's existing ids rather than from a count, so deleting r3 and adding a river gives r4 and never a second r3. Reusing an id would silently merge two objects' undo history and their persisted selection.
const PREFIXES = { lake: 'l', river: 'r', road: 'd' }

export class IdAllocator {
  constructor(doc = null) {
    this.highest = { l: 0, r: 0, d: 0 }
    if (doc !== null) this.observeDoc(doc)
  }

  observeDoc(doc) {
    for (const list of [doc.lakes, doc.rivers, doc.roads]) {
      if (!Array.isArray(list)) continue
      for (const rec of list) this.observe(rec.id)
    }
  }

  observe(idString) {
    if (typeof idString !== 'string') return
    const m = /^([lrd])(\d+)$/.exec(idString)
    if (m === null) return
    const n = Number(m[2])
    if (n > this.highest[m[1]]) this.highest[m[1]] = n
  }

  // kind: 'lake' | 'river' | 'road'
  alloc(kind) {
    const p = PREFIXES[kind]
    if (p === undefined) throw new Error(`IdAllocator.alloc: unknown kind ${JSON.stringify(kind)}, expected lake/river/road`)
    this.highest[p] += 1
    return `${p}${this.highest[p]}`
  }
}
