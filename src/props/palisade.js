// The palisade post (DESIGN.md §41): a pine trunk 0.3 m across and 4 m out of the ground, its top shaved to a point. Three-only, pure of the world: the labyrinths' walls (v2/render/palisades.js) and /gen-palisade both build it here.
//
// ATTRIBUTES: { position, normal, uvProj, texLayer, color }, non-indexed, for createPropMaterial({ vertexColors: true }). The shaft wears BARK_PINE and is smooth shaded; the shaved facets wear TIMBER_BEAM, flat shaded so each cut keeps its arris.
import THREE from '../three-instance.js'
import { mulberry32 } from '../sim/mathx.js'
import { LAYER } from '../textures.js'

export const POST = {
  // Metres. `radius` is the most the jitter ever reaches: a post's silhouette never passes it, so posts set 2 * radius apart touch at worst.
  radius: 0.15,
  height: 4,
  // Below the ground line, so a post on a slope does not show daylight under its downhill side.
  bury: 0.4,
  // The shaved point: the bark ends this far under the apex, each facet's top edge staggered by `stagger` of it.
  tip: 0.42,
  stagger: 0.35,
  // Radial jitter as a share of the radius, all inward, and the ring centres' wander off the axis in metres. With
  // labyrinths.js POST_SPACING these set the widest crack in a wall: 0.29 - 2 * 0.15 * 0.93 * cos(pi / 9) + 2 * bow, 4 cm.
  rough: 0.07,
  bow: 0.006,
  // World metres one texture tile covers (deadwood.js texMetres).
  texMetres: 0.86,
  // The rows of TIMBER_BEAM's tile the point samples across a facet: its lightest band, clear of the dark seam between its two logs (rows 56-100 of 128).
  tipBand: [0.07, 0.37],
}

// Display brightness against the plain prop and card: the mesh is darkened and the card (photographed off the mesh) lightened by card / mesh in its sRGB bytes. The vertex colours are linear, hence the 2.2.
export const POST_TONE = { mesh: 0.8, card: 1.2 }
const MESH_GAIN = POST_TONE.mesh ** 2.2

/** Lift a bake of a post (bakeImpostor's sRGB RGBA bytes) from the mesh's tone to the card's, in place. */
export function tonePostCard(pixels) {
  const k = POST_TONE.card / POST_TONE.mesh
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = Math.min(255, pixels[i] * k)
    pixels[i + 1] = Math.min(255, pixels[i + 1] * k)
    pixels[i + 2] = Math.min(255, pixels[i + 2] * k)
  }
  return pixels
}

// LOD0 and LOD1 (the user's spec): sides round, shaft segments up to the tip.
export const POST_LODS = [{ sides: 9, segments: 5 }, { sides: 7, segments: 1 }]

const TAU = Math.PI * 2

/**
 * One post at `lod` (0 or 1), standing on y = 0 with its apex at POST.height. `seed` picks the roughness; both LODs off one seed share the ring heights and the apex, so a swap moves no silhouette edge but the facets'.
 */
export function buildPalisadePost({ lod = 0, seed = 1 } = {}) {
  const spec = POST_LODS[lod]
  if (!spec) throw new Error(`buildPalisadePost: lod is 0 or 1, not ${lod}`)
  const { sides, segments } = spec
  const rand = mulberry32(seed * 7919 + 13)
  const top = POST.height - POST.tip
  const apex = [(rand() - 0.5) * POST.bow * 2, POST.height, (rand() - 0.5) * POST.bow * 2]
  // Rough-hewn on LOD0 alone; LOD1's seven sides are already coarse past the distance it is drawn at.
  const rough = lod === 0 ? POST.rough : POST.rough * 0.4
  const rings = []
  for (let s = 0; s <= segments; s++) {
    const y = -POST.bury + ((top + POST.bury) * s) / segments
    const cx = s === 0 ? 0 : (rand() - 0.5) * POST.bow * 2
    const cz = s === 0 ? 0 : (rand() - 0.5) * POST.bow * 2
    const ring = []
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * TAU
      const r = POST.radius * (1 - rough * rand())
      // The top ring is the bark's edge, staggered per side so the cut line reads as hand work.
      const yy = s === segments ? y - POST.tip * POST.stagger * rand() : y
      ring.push({ p: [cx + Math.cos(a) * r, yy, cz + Math.sin(a) * r], n: [Math.cos(a), 0, Math.sin(a)], a })
    }
    rings.push(ring)
  }

  const pos = [], nrm = [], uv = [], layer = [], col = []
  const uRepeat = Math.max(1, Math.round((TAU * POST.radius) / POST.texMetres))
  const put = (p, n, u, v, l, shade) => {
    pos.push(p[0], p[1], p[2])
    nrm.push(n[0], n[1], n[2])
    uv.push(u, v)
    layer.push(l)
    col.push(shade * MESH_GAIN, shade * MESH_GAIN, shade * MESH_GAIN * 0.97)
  }
  const shade = () => 0.86 + 0.14 * rand()
  for (let s = 0; s < segments; s++) {
    const lo = rings[s], hi = rings[s + 1]
    for (let k = 0; k < sides; k++) {
      const k1 = (k + 1) % sides
      const u0 = (k / sides) * uRepeat, u1 = ((k + 1) / sides) * uRepeat
      const c = shade()
      const v = (q) => q.p[1] / POST.texMetres
      // Wound so the face's normal points out of the post.
      put(lo[k].p, lo[k].n, u0, v(lo[k]), LAYER.BARK_PINE, c)
      put(hi[k].p, hi[k].n, u0, v(hi[k]), LAYER.BARK_PINE, c)
      put(hi[k1].p, hi[k1].n, u1, v(hi[k1]), LAYER.BARK_PINE, c)
      put(lo[k].p, lo[k].n, u0, v(lo[k]), LAYER.BARK_PINE, c)
      put(hi[k1].p, hi[k1].n, u1, v(hi[k1]), LAYER.BARK_PINE, c)
      put(lo[k1].p, lo[k1].n, u1, v(lo[k1]), LAYER.BARK_PINE, c)
    }
  }
  // The shaved point: one flat facet per side from the bark's edge to the apex. The tile's grain runs along u, so u climbs the facet and v crosses it inside `tipBand`.
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), fn = new THREE.Vector3()
  const ring = rings[segments]
  const [v0, v1] = POST.tipBand
  for (let k = 0; k < sides; k++) {
    const a = ring[k].p, b = ring[(k + 1) % sides].p
    e1.set(apex[0] - a[0], apex[1] - a[1], apex[2] - a[2])
    e2.set(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    fn.crossVectors(e1, e2).normalize()
    const n = [fn.x, fn.y, fn.z]
    const c = 1.05 + 0.1 * rand()
    put(a, n, a[1] / POST.texMetres, v0, LAYER.TIMBER_BEAM, c)
    put(apex, n, apex[1] / POST.texMetres, (v0 + v1) / 2, LAYER.TIMBER_BEAM, c)
    put(b, n, b[1] / POST.texMetres, v1, LAYER.TIMBER_BEAM, c)
  }

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
  g.setAttribute('uvProj', new THREE.Float32BufferAttribute(uv, 2))
  g.setAttribute('texLayer', new THREE.Float32BufferAttribute(layer, 1))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  g.computeBoundingBox()
  g.computeBoundingSphere()
  return g
}

/** The frame a post's card is photographed in (impostor.js bakeImpostor): as wide as the post and as tall. */
export const POST_CARD_FRAME = { width: POST.radius * 2, height: POST.height }

// The torch at the labyrinth's gate: a stake with a pitch-wrapped head, its flame standing on `height`.
export const TORCH_POLE = { height: 1.75, radius: 0.045, head: 0.28, headRadius: 0.075, bury: 0.3 }

/** One gate torch's pole on y = 0, in the post's attributes: a bark stake, its head dark with pitch. */
export function buildTorchPole() {
  const T = TORCH_POLE
  const parts = [
    [new THREE.CylinderGeometry(T.radius * 0.8, T.radius, T.height - T.head + T.bury, 7, 1, true), (T.height - T.head - T.bury) / 2, LAYER.BARK, 0.8],
    [new THREE.CylinderGeometry(T.headRadius, T.headRadius * 0.85, T.head, 7, 1, false), T.height - T.head / 2, LAYER.TIMBER_BEAM, 0.18],
  ]
  const pos = [], nrm = [], uv = [], layer = [], col = []
  for (const [g0, y, l, shade] of parts) {
    const g = g0.toNonIndexed()
    g.translate(0, y, 0)
    const p = g.getAttribute('position'), n = g.getAttribute('normal'), u = g.getAttribute('uv')
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i))
      nrm.push(n.getX(i), n.getY(i), n.getZ(i))
      uv.push(u.getX(i) * 0.4, p.getY(i) / POST.texMetres)
      layer.push(l)
      col.push(shade, shade * 0.95, shade * 0.9)
    }
    g0.dispose()
    g.dispose()
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
  g.setAttribute('uvProj', new THREE.Float32BufferAttribute(uv, 2))
  g.setAttribute('texLayer', new THREE.Float32BufferAttribute(layer, 1))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  g.computeBoundingSphere()
  return g
}
