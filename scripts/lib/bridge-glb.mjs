// The standard stone bridge as GLB bytes (design/34-bridges.md): BRIDGE_DEFAULTS at every LOD, one node each (lod0..lod2), and the scene's extras carrying what the game needs of it besides triangles. bake-bridge.mjs writes it; check-bridge.mjs holds the shipped file to it.
import { BRIDGE_DEFAULTS, CAMBER, LODS, buildBridge, planBridge } from '../../src/bridges/bridge.js'

// Deck profile samples over the bridge's length, for walking it.
const DECK_SAMPLES = 64

export function bakeStoneBridge() {
  const plan = planBridge(BRIDGE_DEFAULTS)
  const builds = Array.from({ length: LODS }, (_, lod) => buildBridge(plan, { lod }))
  const { xa, xb } = plan
  const middle = plan.arches[(plan.arches.length - 1) / 2]
  const meta = {
    params: plan.o,
    xa, xb, halfWidth: plan.hw, inner: plan.inner, camber: CAMBER,
    bankA: plan.o.bankA, bankB: plan.o.bankB, top: plan.top, clearance: middle.crown,
    arches: plan.arches.map(({ cx, a, crown }) => ({ cx, a, crown })),
    deck: Array.from({ length: DECK_SAMPLES + 1 }, (_, k) => plan.deckY(xa + ((xb - xa) * k) / DECK_SAMPLES)),
    sockets: builds[0].sockets,
    lights: builds[0].lights,
    triangles: builds.map((b) => b.stats.triangles),
  }
  return glb(builds.map((b) => b.geometry), meta)
}

/** Geometries in the prop material's layout as a GLB: position, normal and color as glTF's own, uvProj and texLayer as custom attributes. */
function glb(geometries, extras) {
  const chunks = []
  let offset = 0
  const views = [], accessors = []
  const addAccessor = (array, type, componentType, count, extra = {}) => {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength })
    chunks.push(bytes)
    offset += bytes.byteLength
    const pad = (4 - (offset % 4)) % 4
    if (pad) { chunks.push(new Uint8Array(pad)); offset += pad }
    accessors.push({ bufferView: views.length - 1, componentType, count, type, ...extra })
    return accessors.length - 1
  }
  const FLOAT = 5126, USHORT = 5123, UINT = 5125
  const meshes = geometries.map((g) => {
    const attr = (name, type) => addAccessor(g.getAttribute(name).array, type, FLOAT, g.getAttribute(name).count)
    const pos = g.getAttribute('position')
    g.computeBoundingBox()
    const { min, max } = g.boundingBox
    const idx = g.getIndex().array
    return {
      primitives: [{
        attributes: {
          POSITION: addAccessor(pos.array, 'VEC3', FLOAT, pos.count, { min: min.toArray(), max: max.toArray() }),
          NORMAL: attr('normal', 'VEC3'),
          COLOR_0: attr('color', 'VEC3'),
          _UVPROJ: attr('uvProj', 'VEC2'),
          _TEXLAYER: attr('texLayer', 'SCALAR'),
        },
        indices: addAccessor(idx, 'SCALAR', idx instanceof Uint16Array ? USHORT : UINT, idx.length),
        mode: 4,
      }],
    }
  })
  const json = {
    asset: { version: '2.0', generator: 'aurora scripts/bake-bridge.mjs' },
    scene: 0,
    scenes: [{ nodes: meshes.map((_, i) => i), extras }],
    nodes: meshes.map((_, i) => ({ name: `lod${i}`, mesh: i })),
    meshes,
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: offset }],
  }
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const jpad = (4 - (jsonBytes.length % 4)) % 4
  if (jpad) jsonBytes = Uint8Array.from([...jsonBytes, ...Array(jpad).fill(0x20)])
  const total = 12 + 8 + jsonBytes.length + 8 + offset
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x46546c67, true)
  dv.setUint32(4, 2, true)
  dv.setUint32(8, total, true)
  dv.setUint32(12, jsonBytes.length, true)
  dv.setUint32(16, 0x4e4f534a, true)
  out.set(jsonBytes, 20)
  let at = 20 + jsonBytes.length
  dv.setUint32(at, offset, true)
  dv.setUint32(at + 4, 0x004e4942, true)
  at += 8
  for (const c of chunks) { out.set(c, at); at += c.byteLength }
  return out
}
