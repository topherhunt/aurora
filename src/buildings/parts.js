import * as THREE from 'three'
import { LAYER, TILE_METRES } from '../textures.js'
import { IRON_ISLANDS, RUNE_ISLANDS } from './tiles.js'

// ---------------------------------------------------------------------------
// The Nordic building kit: the geometry half of DESIGN.md §19.
//
// WHY A BUILDER AND NOT MERGED BufferGeometries. The obvious way to assemble a
// cottage is to make a BoxGeometry per timber and mergeGeometries() the pile.
// It does not work here, for one reason that is worth stating plainly because
// it drove the design of this whole file:
//
//   BoxGeometry's UVs run 0-1 PER FACE. A 4 m wall and a 0.2 m post would each
//   get the texture exactly once, so the logs on the wall would be 20 times the
//   size of the logs on the post. Fixing that means rewriting every uv after
//   the merge, at which point the geometry classes have bought nothing.
//
// So every surface here is emitted directly with UVs computed from WORLD
// EXTENTS divided by TILE_METRES[layer]. Texel density is then constant across
// the whole building by construction, a wall can be resized by a slider without
// anything being re-unwrapped, and a cottage and an inn are visibly the same
// material at the same scale. That is most of what makes a procedural kit look
// authored rather than generated, and it is free.
//
// ATTRIBUTE LAYOUT is {position, normal, uvProj, texLayer, color}. The first
// four are the shared prop layout, deliberately -- `uv` is NOT the name because
// three's `map` path would then assume sampler2D (see material.js). `color` is
// the fifth and is what makes buildings a separate merged mesh rather than part
// of the prop batch; the trade is argued at createPropMaterial().
//
// PER-VERTEX texLayer is the thing that keeps a whole building in one draw
// call: wall vertices carry TIMBER_HEWN, roof vertices THATCH, plinth vertices
// STONE, all in one geometry with one material.
//
// CONVENTIONS, inherited from src/village/shapes.js and NOT negotiable, because
// the village spur-path router depends on both:
//   * Everything sits on y = 0 and is centred on XZ.
//   * THE FRONT DOOR IS ON LOCAL +Z.
// ---------------------------------------------------------------------------

// --- small vector helpers ---------------------------------------------------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
function unit(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

const WHITE = [1, 1, 1]

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export class Builder {
  constructor() {
    this.pos = []
    this.nrm = []
    this.uvp = []
    this.lay = []
    this.col = []
    this.idx = []
  }

  get triangles() {
    return this.idx.length / 3
  }

  get vertices() {
    return this.pos.length / 3
  }

  vertex(p, n, uv, layer, c) {
    this.pos.push(p[0], p[1], p[2])
    this.nrm.push(n[0], n[1], n[2])
    this.uvp.push(uv[0], uv[1])
    this.lay.push(layer)
    this.col.push(c[0], c[1], c[2])
    return this.pos.length / 3 - 1
  }

  /**
   * One quad, corners in order a -> b -> c -> d around the face.
   *
   * THE WINDING DEFINES THE TEXTURE FRAME, which is the convention the rest of
   * this file is written against: a->b is the U axis and a->d is the V axis, so
   * for a wall you pass bottom-left, bottom-right, top-right, top-left and V
   * comes out running up the wall; for a roof slope you pass the two eave
   * corners first and V runs up the slope. The outward normal falls out of the
   * same ordering as cross(b-a, d-a), so a face that is textured right is also
   * facing the right way, and there is only one thing to get wrong instead of
   * two.
   *
   * Options:
   *   layer    required; index into the texture array
   *   tile     metres per UV unit; defaults to TILE_METRES[layer]
   *   origin   world point U and V are measured from; defaults to `a`
   *   vWorldY  measure V as absolute world height rather than from the origin.
   *            Walls use this so log courses line up around a corner and across
   *            every mass of the building -- see wall().
   *   island   {u0,v0,u1,v1}; use these UVs directly. For decal sheets.
   *   uvs      four explicit [u,v] pairs. For anything else non-tiling.
   *   color    [r,g,b] linear, or (p) => [r,g,b]
   *   double   also emit the back face. See below.
   *
   * `double` EMITS THE BACK FACE WITH THE SAME UV FRAME, not a re-derived one.
   * Re-winding d->c->b->a would reverse U and V with it, which mirrors a decal
   * and hangs the thatch fringe upside down on its far side. It also makes the
   * quad self-sealing for the airtightness gate: a lone quad leaves four
   * boundary edges, and a back-to-back pair leaves none.
   */
  quad(a, b, c, d, o) {
    const layer = o.layer
    const tile = o.tile ?? TILE_METRES[layer] ?? 1
    const n = unit(cross(sub(b, a), sub(d, a)))

    let uvAt
    if (o.uvs) {
      const map = new Map([[a, o.uvs[0]], [b, o.uvs[1]], [c, o.uvs[2]], [d, o.uvs[3]]])
      uvAt = (p) => map.get(p)
    } else if (o.island) {
      const { u0, v0, u1, v1 } = o.island
      const map = new Map([[a, [u0, v0]], [b, [u1, v0]], [c, [u1, v1]], [d, [u0, v1]]])
      uvAt = (p) => map.get(p)
    } else {
      const origin = o.origin ?? a
      const uh = unit(sub(b, a))
      // Gram-Schmidt, so a sheared quad (a catslide verge, a battered plinth)
      // still gets a square frame instead of a skewed one.
      const raw = sub(d, a)
      const vh = unit([
        raw[0] - uh[0] * dot(raw, uh),
        raw[1] - uh[1] * dot(raw, uh),
        raw[2] - uh[2] * dot(raw, uh),
      ])
      uvAt = (p) => {
        const r = sub(p, origin)
        return [dot(r, uh) / tile, (o.vWorldY ? p[1] : dot(r, vh)) / tile]
      }
    }

    const tint = typeof o.color === 'function' ? o.color : () => o.color ?? WHITE
    const emit = (p, q, r, s, nrm) => {
      const i0 = this.vertex(p, nrm, uvAt(p), layer, tint(p))
      const i1 = this.vertex(q, nrm, uvAt(q), layer, tint(q))
      const i2 = this.vertex(r, nrm, uvAt(r), layer, tint(r))
      const i3 = this.vertex(s, nrm, uvAt(s), layer, tint(s))
      this.idx.push(i0, i1, i2, i0, i2, i3)
    }
    emit(a, b, c, d, n)
    if (o.double) emit(a, d, c, b, [-n[0], -n[1], -n[2]])
    return this
  }

  /** One triangle. Same frame convention: a->b is U, a->c seeds V.
   *  Takes `double` on the same terms as quad(). */
  tri(a, b, c, o) {
    const layer = o.layer
    const tile = o.tile ?? TILE_METRES[layer] ?? 1
    const n = unit(cross(sub(b, a), sub(c, a)))
    const origin = o.origin ?? a
    const uh = unit(sub(b, a))
    const raw = sub(c, a)
    const vh = unit([
      raw[0] - uh[0] * dot(raw, uh),
      raw[1] - uh[1] * dot(raw, uh),
      raw[2] - uh[2] * dot(raw, uh),
    ])
    const uvAt = (p) => {
      const r = sub(p, origin)
      return [dot(r, uh) / tile, (o.vWorldY ? p[1] : dot(r, vh)) / tile]
    }
    const tint = typeof o.color === 'function' ? o.color : () => o.color ?? WHITE
    const emit = (p, q, r, nrm) => {
      const i0 = this.vertex(p, nrm, uvAt(p), layer, tint(p))
      const i1 = this.vertex(q, nrm, uvAt(q), layer, tint(q))
      const i2 = this.vertex(r, nrm, uvAt(r), layer, tint(r))
      this.idx.push(i0, i1, i2)
    }
    emit(a, b, c, n)
    if (o.double) emit(a, c, b, [-n[0], -n[1], -n[2]])
    return this
  }

  /**
   * An axis-aligned box from `min` to `max`.
   *
   * `skip` drops faces by name ('+x','-x','+y','-y','+z','-z'). It exists, but
   * NOTHING IN THE KIT USES IT ANY MORE and new code should not reach for it.
   * Dropping the face buried in a wall used to save a fifth of a building's
   * budget on triangles nobody could see; what it actually bought was a mesh
   * full of holes, and the holes were visible from inside the building and
   * through every roof valley. Airtightness is the gate now
   * (scripts/check-buildings.mjs), a hole fails it, and the four triangles a
   * closed step tread costs are not worth arguing about.
   *
   * Side faces measure V as world height so a box of logs courses in with the
   * wall behind it; top and bottom project onto XZ.
   */
  box(min, max, o) {
    const [x0, y0, z0] = min
    const [x1, y1, z1] = max
    const skip = new Set(o.skip ?? [])
    const q = (a, b, c, d, extra) => this.quad(a, b, c, d, { ...o, ...extra })

    if (!skip.has('+z')) q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], { vWorldY: true })
    if (!skip.has('-z')) q([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], { vWorldY: true })
    if (!skip.has('+x')) q([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], { vWorldY: true })
    if (!skip.has('-x')) q([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], { vWorldY: true })
    if (!skip.has('+y')) q([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], {})
    if (!skip.has('-y')) q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], {})
    return this
  }

  toGeometry() {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3))
    g.setAttribute('uvProj', new THREE.Float32BufferAttribute(this.uvp, 2))
    g.setAttribute('texLayer', new THREE.Float32BufferAttribute(this.lay, 1))
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3))
    const Index = this.vertices > 65535 ? THREE.Uint32BufferAttribute : THREE.Uint16BufferAttribute
    g.setIndex(new Index(this.idx, 1))
    g.computeBoundingSphere()
    return g
  }
}

// ---------------------------------------------------------------------------
// Airtightness
// ---------------------------------------------------------------------------

/**
 * Every open edge in a geometry: the gate that says a building has no holes.
 *
 * THE INVARIANT IS DIRECTED-EDGE PAIRING. Quantise every vertex position, then
 * for every triangle count its three directed edges a->b. The mesh is closed
 * iff count(a->b) === count(b->a) for every pair. Returns the unmatched ones.
 *
 * Why that test and not "every edge is shared by exactly two triangles", which
 * is the one everybody writes first: this kit is a UNION OF INTERPENETRATING
 * SOLIDS, not a boolean union. A chimney is a box driven through a roof slope;
 * a log end is a box driven through a wall. Nothing is cut, so faces cross each
 * other freely and an edge can legitimately be shared by four triangles where
 * two solids happen to touch along a line. Counting incidences flags that as a
 * defect. Counting DIRECTIONS does not: two closed shells overlapping still
 * balance, because each shell balances on its own.
 *
 * It also passes the other thing this kit is made of, which the two-triangle
 * rule rejects outright: a back-to-back double-sided quad. The thatch fringe
 * and the ironwork decals are zero-thickness by design -- alpha carries their
 * shape -- and a front face plus its mirrored back face balances every edge.
 *
 * What it still catches is the thing that was actually wrong: a roof slope
 * emitted as a single quad, a step tread with its underside skipped, a lean-to
 * with no triangle closing its end. All of those leave a directed edge with no
 * partner, and all of them are a hole you can see the inside of the building
 * through.
 *
 * `eps` quantises positions before comparing, because two parts that are meant
 * to share a corner arrive there by different arithmetic. 1e-4 m is far below
 * anything the kit places deliberately and far above float drift.
 */
export function openEdges(geometry, eps = 1e-4) {
  const pos = geometry.getAttribute('position').array
  const index = geometry.getIndex().array
  const q = (i) => {
    const k = i * 3
    return `${Math.round(pos[k] / eps)},${Math.round(pos[k + 1] / eps)},${Math.round(pos[k + 2] / eps)}`
  }
  // One pass, one map: key on the UNORDERED pair and keep a signed count, so a
  // balanced edge nets to zero and only the survivors need looking at.
  const net = new Map()
  for (let t = 0; t < index.length; t += 3) {
    const v = [q(index[t]), q(index[t + 1]), q(index[t + 2])]
    for (let e = 0; e < 3; e++) {
      const a = v[e]
      const b = v[(e + 1) % 3]
      if (a === b) continue // a degenerate triangle has no edge to balance
      const key = a < b ? `${a}|${b}` : `${b}|${a}`
      net.set(key, (net.get(key) ?? 0) + (a < b ? 1 : -1))
    }
  }
  const open = []
  for (const [key, n] of net) if (n !== 0) open.push({ key, imbalance: n })
  return open
}

/**
 * Signed volume, by the divergence theorem: sum of the tetrahedra each triangle
 * makes with the origin.
 *
 * The companion to openEdges(), and it earns its keep because openEdges() has
 * one blind spot -- a shell wound INSIDE OUT balances every edge just as well as
 * a correct one, and renders as a hole in exactly the same way under back-face
 * culling. A shell with outward normals contributes positive volume, an inverted
 * one contributes negative, and a double-sided quad contributes exactly zero, so
 * a building's total should come out near its actual massing. Anything at or
 * below zero means a part is inside out.
 */
export function signedVolume(geometry) {
  const p = geometry.getAttribute('position').array
  const idx = geometry.getIndex().array
  let v = 0
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3
    const b = idx[t + 1] * 3
    const c = idx[t + 2] * 3
    v += (
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])
    ) / 6
  }
  return v
}

// ---------------------------------------------------------------------------
// Palette of tints, applied per vertex over the shared tiles.
//
// This is where a building gets to be its own building without spending a
// texture layer. All linear, because vertex colours multiply the already-decoded
// sRGB sample -- the same convention src/village/shapes.js uses and the
// opposite of the one in tiles.js.
// ---------------------------------------------------------------------------

export const TINT = {
  thatchNew: [1.06, 0.98, 0.78],
  thatchOld: [0.66, 0.66, 0.62],
  slate: [0.52, 0.56, 0.64], // SHINGLE, tinted cold -- this is the whole "slate roof"
  shake: [1, 1, 1],
  pantile: [1, 1, 1], // the fired clay is already in the tile; do not tint it twice
  timber: [1, 1, 1],
  timberDark: [0.62, 0.55, 0.48], // pitch-tarred, as a stave church is
  moss: [0.55, 0.78, 0.42],
  stone: [1, 1, 1],
  glass: [1, 1, 1],
  iron: [1, 1, 1],
}

const mixv = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
]

/**
 * A roof tint that ages toward the eaves and greens where water sits.
 *
 * This is the moss layer that textures.js argues out of existence, delivered
 * instead as a function of position: a roof holds damp lowest down and on its
 * shaded side, so moss belongs near the eave and away from the sun, and both of
 * those are things the geometry already knows. Costs nothing per frame and
 * varies per building for free.
 */
export function roofTint({ base, eaveY, ridgeY, moss = 0.35, ageAtEave = 0.5 }) {
  const span = Math.max(0.001, ridgeY - eaveY)
  return (p) => {
    const up = (p[1] - eaveY) / span // 0 at the eave, 1 at the ridge
    const damp = Math.max(0, 1 - up * 1.6)
    const c = mixv(base, mixv(base, TINT.thatchOld, ageAtEave), damp)
    // North (-Z) is the shaded side in a northern-hemisphere scene.
    const shade = p[2] < 0 ? 1 : 0.35
    return mixv(c, TINT.moss, Math.min(1, damp * damp * moss * shade))
  }
}

/** Plaster and stone darken toward the ground, where rain splashes dirt up. */
export function groundGrime(y0, height = 0.9, strength = 0.32) {
  return (p) => {
    const t = Math.max(0, 1 - (p[1] - y0) / height)
    const k = 1 - t * t * strength
    return [k, k * 0.99, k * 0.96]
  }
}

// ---------------------------------------------------------------------------
// Parts
//
// Every part takes the Builder first and a spec object second, adds triangles,
// and returns whatever the caller needs back (usually nothing). None of them
// know about the plan -- they are a vocabulary, and plan.js writes sentences.
// ---------------------------------------------------------------------------

/** Wall styles. One is chosen per BUILDING, not per wall: mixing them makes a
 *  building read as several buildings pushed together. */
export const WALL_STYLE = {
  LOG: 'log', // horizontal round-log courses, notched ends at the corners
  STAVE: 'stave', // vertical planks between corner posts
  HALF_TIMBER: 'halfTimber', // plaster panels in an exposed frame
  STONE_BASE: 'stoneBase', // masonry to sill height, timber above
}

/**
 * A rubble plinth.
 *
 * `bottom` is deliberately a separate argument from `top` rather than a height:
 * the plan samples the terrain at all four footprint corners, sets the floor at
 * the HIGHEST of them and grows the plinth down to the LOWEST, so a building on
 * a slope gets a tall plinth on the downhill side and cannot ever float. The
 * batter (the slight inward lean) is what stops it reading as a cardboard box.
 */
export function plinth(b, { cx, cz, w, d, top, bottom, batter = 0.05, tint = TINT.stone }) {
  const grime = groundGrime(bottom, 1.1, 0.3)
  const color = (p) => {
    const g = grime(p)
    return [g[0] * tint[0], g[1] * tint[1], g[2] * tint[2]]
  }
  const hw = w / 2
  const hd = d / 2
  const bw = hw + batter
  const bd = hd + batter
  const corners = [
    [[-bw, bottom, bd], [bw, bottom, bd], [hw, top, hd], [-hw, top, hd]],
    [[bw, bottom, bd], [bw, bottom, -bd], [hw, top, -hd], [hw, top, hd]],
    [[bw, bottom, -bd], [-bw, bottom, -bd], [-hw, top, -hd], [hw, top, -hd]],
    [[-bw, bottom, -bd], [-bw, bottom, bd], [-hw, top, hd], [-hw, top, -hd]],
  ]
  for (const [a, bb, c, dd] of corners) {
    b.quad(
      [a[0] + cx, a[1], a[2] + cz],
      [bb[0] + cx, bb[1], bb[2] + cz],
      [c[0] + cx, c[1], c[2] + cz],
      [dd[0] + cx, dd[1], dd[2] + cz],
      { layer: LAYER.STONE, vWorldY: true, color }
    )
  }
  // The ledge the walls stand on, and the sole under it. The sole is buried in
  // the hill and nobody will ever see it; it is here because the plinth is the
  // bottom of the building and a solid needs a bottom -- see openEdges().
  b.quad(
    [cx - hw, top, cz + hd], [cx + hw, top, cz + hd],
    [cx + hw, top, cz - hd], [cx - hw, top, cz - hd],
    { layer: LAYER.STONE, color: tint }
  )
  b.quad(
    [cx - bw, bottom, cz - bd], [cx + bw, bottom, cz - bd],
    [cx + bw, bottom, cz + bd], [cx - bw, bottom, cz + bd],
    { layer: LAYER.STONE, color: tint }
  )
}

/**
 * One wall, from p0 to p1 in XZ. Wind p0 -> p1 so the outward normal is
 * (-dz, 0, dx) -- i.e. walk the footprint front, right, back, left.
 *
 * V IS MEASURED IN ABSOLUTE WORLD HEIGHT on every style. That single choice is
 * what makes log courses meet at the corners and run level all the way around,
 * and it keeps them level across a wing built at a different floor height too.
 * Measuring from each wall's own base instead is the classic way to get a
 * building whose logs step at every corner.
 */
export function wall(b, { p0, p1, y0, y1, style, seed = 0, sillY, detail = 2, tint = TINT.timber }) {
  const dx = p1[0] - p0[0]
  const dz = p1[1] - p0[1]
  const len = Math.hypot(dx, dz)
  if (len < 0.01 || y1 <= y0) return
  const ux = dx / len
  const uz = dz / len
  const nx = -uz
  const nz = ux

  const A = (t, y) => [p0[0] + ux * len * t, y, p0[1] + uz * len * t]
  // Double-sided, and NOT because anyone is meant to see the inside face. A
  // wall is one quad because openings are never cut out of it (see below), so
  // giving it real thickness would triple the cost of the cheapest part in the
  // kit for a reveal that no window ever exposes. The back face is what closes
  // it instead: a lone quad leaves four open edges, and the inside of a
  // building whose walls are one-sided is a view straight out through them.
  const face = (ya, yb, layer, color) =>
    b.quad(A(0, ya), A(1, ya), A(1, yb), A(0, yb), { layer, vWorldY: true, color, double: true })

  const split = sillY ?? y0 + (y1 - y0) * 0.38

  if (style === WALL_STYLE.STONE_BASE) {
    face(y0, split, LAYER.STONE, groundGrime(y0, 1.0, 0.28))
    face(split, y1, LAYER.TIMBER_PLANK, tint)
    // The offset where the timber sits back on the masonry, as a real ledge.
    if (detail >= 2) {
      const t = 0.06
      b.quad(
        [p0[0] + nx * t, split, p0[1] + nz * t],
        [p1[0] + nx * t, split, p1[1] + nz * t],
        [p1[0], split, p1[1]],
        [p0[0], split, p0[1]],
        { layer: LAYER.STONE, color: TINT.stone, double: true }
      )
    }
    return
  }

  if (style === WALL_STYLE.HALF_TIMBER) {
    face(y0, y1, LAYER.PLASTER, groundGrime(y0, y1 - y0, 0.34))
    if (detail < 2) return
    // The frame, standing proud of the plaster. Sill, head, two posts, and one
    // brace per bay -- which is what actually tells the eye "half-timbered",
    // far more than the plaster does.
    const t = 0.075 // how far the timber stands out
    const w = 0.16 // member width
    const rail = (ya, yb) => {
      b.box(
        [Math.min(p0[0], p1[0]) - (ux ? 0 : t), ya, Math.min(p0[1], p1[1]) - (uz ? 0 : t)],
        [Math.max(p0[0], p1[0]) + (ux ? 0 : t), yb, Math.max(p0[1], p1[1]) + (uz ? 0 : t)],
        { layer: LAYER.TIMBER_HEWN, color: TINT.timberDark }
      )
    }
    rail(y0, y0 + w)
    rail(y1 - w, y1)
    const bays = Math.max(1, Math.round(len / 1.5))
    for (let i = 0; i <= bays; i++) {
      const s = i / bays
      const px = p0[0] + dx * s
      const pz = p0[1] + dz * s
      const hx = (ux ? w / 2 : t)
      const hz = (uz ? w / 2 : t)
      b.box(
        [px - hx, y0 + w, pz - hz],
        [px + hx, y1 - w, pz + hz],
        { layer: LAYER.TIMBER_HEWN, color: TINT.timberDark }
      )
    }
    return
  }

  if (style === WALL_STYLE.STAVE) {
    face(y0, y1, LAYER.TIMBER_PLANK, tint)
    if (detail < 2) return
    // Corner posts, which is what a stave wall is actually framed by.
    for (const t of [0, 1]) {
      const px = p0[0] + dx * t
      const pz = p0[1] + dz * t
      b.box(
        [px - 0.11, y0, pz - 0.11],
        [px + 0.11, y1 + 0.04, pz + 0.11],
        { layer: LAYER.TIMBER_HEWN, color: TINT.timberDark }
      )
    }
    return
  }

  // WALL_STYLE.LOG
  face(y0, y1, LAYER.TIMBER_HEWN, tint)
  if (detail < 2) return

  // Notched log ends poking past the corner. This is the silhouette of a log
  // cabin and nothing else in the kit supplies it -- the flat texture alone
  // reads as painted-on stripes. Only every other course sticks out on a given
  // wall, because the courses interlock: the ones between belong to the wall
  // running the other way.
  const course = TILE_METRES[LAYER.TIMBER_HEWN] / 2
  const r = course * 0.46
  const stick = 0.22
  const phase = seed & 1
  for (let k = 0; ; k++) {
    const y = y0 + course * (k + 0.5)
    if (y + r > y1) break
    if ((k & 1) !== phase) continue
    for (const t of [0, 1]) {
      const px = p0[0] + dx * t
      const pz = p0[1] + dz * t
      const out = t === 0 ? -1 : 1
      const ex = px + ux * out * stick
      const ez = pz + uz * out * stick
      b.box(
        [Math.min(px, ex) - (ux ? 0 : r), y - r, Math.min(pz, ez) - (uz ? 0 : r)],
        [Math.max(px, ex) + (ux ? 0 : r), y + r, Math.max(pz, ez) + (uz ? 0 : r)],
        { layer: LAYER.TIMBER_HEWN, color: tint }
      )
    }
  }
}

/**
 * The triangle of wall between the eave and the ridge at a gable end.
 * `p0 -> p1` runs along the base with the same winding rule as wall().
 */
export function gableEnd(b, { p0, p1, y0, apexY, style, tint = TINT.timber, detail = 2 }) {
  const layer =
    style === WALL_STYLE.LOG ? LAYER.TIMBER_HEWN : LAYER.TIMBER_PLANK
  const mx = (p0[0] + p1[0]) / 2
  const mz = (p0[1] + p1[1]) / 2
  // Double-sided for the same reason wall() is: it is a wall, and the roof
  // verge overhangs past it, so its thickness is never in view.
  b.tri(
    [p0[0], y0, p0[1]],
    [p1[0], y0, p1[1]],
    [mx, apexY, mz],
    { layer, vWorldY: true, color: tint, double: true }
  )
  if (detail < 2) return
  // A vertical king post up the middle of the gable, which every timber gable
  // has and which breaks up an otherwise blank triangle.
  b.box(
    [mx - 0.09, y0, mz - 0.09],
    [mx + 0.09, apexY - 0.12, mz + 0.09],
    { layer: LAYER.TIMBER_HEWN, color: TINT.timberDark }
  )
}

/** How thick a roof of each covering is, in metres. A thatched roof is a
 *  half-metre of packed straw and a shingled one is a board and a shake. */
const ROOF_THICKNESS = { [LAYER.THATCH]: 0.3, [LAYER.SHINGLE]: 0.11 }

/**
 * One roof plane, with a real thickness.
 *
 * `corners` are the four corners of the TOP surface in quad winding (eave-left,
 * eave-right, ridge-right, ridge-left), so the caller keeps the UV frame it
 * already had and this only adds what is under it.
 *
 * THE THICKNESS IS VERTICAL, not normal to the slope, which is both cheaper and
 * more correct: a roof is rafters and covering stacked on a wall plate and cut
 * plumb at the eave, so the band you see along an overhanging edge is a plumb
 * cut through the covering. The underside is boarding rather than more thatch,
 * because that is what is actually over your head when you stand under an eave,
 * and because a dark plank soffit is what makes an overhang read as depth
 * instead of as a thick outline.
 *
 * Before this existed each slope was a single quad. From below and from behind
 * -- under the verge, in a roof valley, anywhere inside -- it was backface-
 * culled to nothing, which is most of what "I can see inside the building" was.
 */
function roofPlane(b, corners, t, { layer, color }) {
  const [a, c1, c2, c3] = corners
  const down = (p) => [p[0], p[1] - t, p[2]]
  const soffit = { layer: LAYER.TIMBER_PLANK, color: TINT.timberDark }

  b.quad(a, c1, c2, c3, { layer, color })
  b.quad(down(a), down(c3), down(c2), down(c1), soffit)
  // The plumb-cut band around the edge, in the covering itself. Winding is
  // (below-p, below-q, q, p) for each edge of the top loop, which faces outward
  // wherever the top surface faces upward -- true of every roof plane here.
  for (const [p, q] of [[a, c1], [c1, c2], [c2, c3], [c3, a]]) {
    b.quad(down(p), down(q), q, p, { layer, color, vWorldY: true })
  }
}

/**
 * A gable roof over an axis-aligned mass.
 *
 * `ridgeAxis` is 'x' or 'z' and names the axis the RIDGE runs along, so the
 * slopes face the other one. Returns the ridge height, which the chimney and
 * any abutting catslide need.
 *
 * `verge` is how far the roof oversails the gable wall. `vergeLo` and `vergeHi`
 * override it at the low and high end of the ridge axis independently, which is
 * how a wing roof is driven INTO the roof it abuts instead of stopping at its
 * own wall -- see wingVerge() in building.js. A T-plan whose two ridges do not
 * actually reach each other leaves a notch at the junction that you can see the
 * far slope through, and that notch is not a hole any amount of face-adding
 * fixes: the two roofs simply have to overlap.
 */
export function gableRoof(
  b,
  {
    cx, cz, w, d, eaveY, rise,
    ridgeAxis = 'x',
    overhang = 0.4,
    verge = 0.3,
    vergeLo = null,
    vergeHi = null,
    layer = LAYER.THATCH,
    tint = TINT.thatchNew,
    moss = 0.35,
    fringe = true,
    detail = 2,
  }
) {
  const ridgeY = eaveY + rise
  // Along the ridge, and across it. The two ends of the ridge are independent:
  // aLo and aHi are signed offsets from the centre, not a half-extent.
  const half = (ridgeAxis === 'x' ? w : d) / 2
  const aLo = -(half + (vergeLo ?? verge))
  const aHi = half + (vergeHi ?? verge)
  const alongHalf = Math.max(-aLo, aHi)
  const runHalf = (ridgeAxis === 'x' ? d : w) / 2
  // Overhanging past the wall means continuing down the same plane, so the
  // eave ends up BELOW the wall top. That drop is the thing that makes a roof
  // look like it was built rather than placed.
  const drop = (rise / Math.max(0.001, runHalf)) * overhang
  const eave = eaveY - drop
  const run = runHalf + overhang

  const color = roofTint({ base: tint, eaveY: eave, ridgeY, moss })

  // Two slopes. Corners are ordered eave-left, eave-right, ridge-right,
  // ridge-left, so U runs along the eave and V runs UP the slope, which is the
  // orientation tileThatch and tileShingles are drawn for.
  const thick = ROOF_THICKNESS[layer] ?? 0.12
  const slope = (sign) => {
    const P = (alongT, up) => {
      const a = aLo + (aHi - aLo) * alongT
      const acr = sign * (up ? 0 : run)
      const y = up ? ridgeY : eave
      return ridgeAxis === 'x' ? [cx + a, y, cz + acr] : [cx + acr, y, cz + a]
    }
    // Wind so the face points outward on each side. The along-axis runs +x for
    // a ridge on x and +z for a ridge on z, but the across-axis it is crossed
    // with does NOT change sign to match, so the handedness of (along, across)
    // flips with the ridge axis and the winding has to flip back. Getting this
    // wrong pointed both slopes of every z-ridged roof downwards and inwards,
    // which is invisible to the airtightness gate -- an inside-out shell pairs
    // its edges perfectly -- and is why signedVolume() exists beside it.
    roofPlane(b, (ridgeAxis === 'x') === (sign > 0)
      ? [P(0, false), P(1, false), P(1, true), P(0, true)]
      : [P(1, false), P(0, false), P(0, true), P(1, true)], thick, { layer, color })
  }
  slope(1)
  slope(-1)

  if (detail >= 2) {
    // The ridge capping: a shallow box along the top, which hides the seam
    // where the two slopes meet and reads as the ridge roll a thatcher pegs on.
    const t = 0.13
    const min = ridgeAxis === 'x'
      ? [cx + aLo, ridgeY - t, cz - t]
      : [cx - t, ridgeY - t, cz + aLo]
    const max = ridgeAxis === 'x'
      ? [cx + aHi, ridgeY + t * 0.7, cz + t]
      : [cx + t, ridgeY + t * 0.7, cz + aHi]
    b.box(min, max, { layer, color: tint })
  }

  // The frayed eave. Alpha carries the shape, so this is a hanging strip rather
  // than modelled straw: one quad per eave, two triangles, and the silhouette
  // of a thatched cottage arrives for four triangles a building.
  //
  // Kept at detail 1, unlike every other ornament here, precisely BECAUSE it is
  // silhouette: dropping it at the LOD0 boundary would pop the outline of the
  // roof at 60 m, and four triangles is not a price worth paying that for.
  if (fringe && detail >= 1 && layer === LAYER.THATCH) {
    const dropH = 0.34
    const uSpan = (aHi - aLo) / TILE_METRES[LAYER.THATCH_FRINGE]
    for (const sign of [1, -1]) {
      const P = (alongT, y, push) => {
        const a = aLo + (aHi - aLo) * alongT
        const acr = sign * (run + push)
        return ridgeAxis === 'x' ? [cx + a, y, cz + acr] : [cx + acr, y, cz + a]
      }
      // v = 0 at the hanging tip, v = 1 at the eave line -- see tileFringe.
      // Doubled, because a fringe hangs clear of the roof and you see its back
      // from anywhere below the eave line, which is most of a village street.
      const uvs = [[0, 0], [uSpan, 0], [uSpan, 1], [0, 1]]
      const lo = eave - thick - dropH
      const top = eave - thick
      const o = { layer: LAYER.THATCH_FRINGE, uvs, color: tint, double: true }
      // Same handedness flip as the slope above. Doubled, so this only decides
      // which side gets the front face's normal -- but that is the lit one.
      if ((ridgeAxis === 'x') === (sign > 0)) b.quad(P(0, lo, 0.02), P(1, lo, 0.02), P(1, top, 0), P(0, top, 0), o)
      else b.quad(P(1, lo, 0.02), P(0, lo, 0.02), P(0, top, 0), P(1, top, 0), o)
    }
  }

  return { ridgeY, eave, alongHalf, run }
}

/**
 * A single-pitch roof: the lean-to on a side outshut, and the catslide where a
 * smaller mass abuts a larger one and its roof simply carries on down.
 *
 * `dir` is the outward direction the slope falls toward: '+x','-x','+z','-z'.
 */
export function leanToRoof(
  b,
  { cx, cz, w, d, highY, lowY, dir = '+z', overhang = 0.3, layer = LAYER.THATCH, tint = TINT.thatchNew, detail = 2 }
) {
  const axis = dir[1] // 'x' or 'z'
  const sign = dir[0] === '+' ? 1 : -1
  const runHalf = (axis === 'x' ? w : d) / 2
  const alongHalf = (axis === 'x' ? d : w) / 2 + 0.25
  const drop = ((highY - lowY) / Math.max(0.001, 2 * runHalf)) * overhang
  const eave = lowY - drop
  const run = runHalf + overhang

  const P = (alongT, down) => {
    const a = -alongHalf + 2 * alongHalf * alongT
    const acr = sign * (down ? run : -runHalf)
    const y = down ? eave : highY
    return axis === 'x' ? [cx + acr, y, cz + a] : [cx + a, y, cz + acr]
  }
  const color = roofTint({ base: tint, eaveY: eave, ridgeY: highY, moss: 0.3 })
  const thick = ROOF_THICKNESS[layer] ?? 0.12
  // Eave corners first so V runs up the slope, as on a gable.
  const flip = (axis === 'x') === (sign > 0)
  roofPlane(b, flip
    ? [P(1, true), P(0, true), P(0, false), P(1, false)]
    : [P(0, true), P(1, true), P(1, false), P(0, false)], thick, { layer, color })

  if (detail >= 1 && layer === LAYER.THATCH) {
    const uSpan = (2 * alongHalf) / TILE_METRES[LAYER.THATCH_FRINGE]
    const uvs = [[0, 0], [uSpan, 0], [uSpan, 1], [0, 1]]
    const E = (alongT, y, push) => {
      const a = -alongHalf + 2 * alongHalf * alongT
      const acr = sign * (run + push)
      return axis === 'x' ? [cx + acr, y, cz + a] : [cx + a, y, cz + acr]
    }
    const top = eave - thick
    const lo = top - 0.3
    const o = { layer: LAYER.THATCH_FRINGE, uvs, color: tint, double: true }
    if (flip) b.quad(E(1, lo, 0.02), E(0, lo, 0.02), E(0, top, 0), E(1, top, 0), o)
    else b.quad(E(0, lo, 0.02), E(1, lo, 0.02), E(1, top, 0), E(0, top, 0), o)
  }
  return { eave, run, highY, runHalf, alongHalf, axis, sign, thick }
}

/**
 * The triangle of wall between a lean-to's side wall and the slope above it.
 *
 * An outshut's side walls stop at its own eave while its roof carries on up to
 * the main wall, which leaves a right triangle of nothing at each end. That
 * gap was open sky straight into the shed -- the most literal instance of "I
 * can see inside the building" in the kit, and one no amount of double-siding
 * the roof would have closed, because the face was never there to begin with.
 *
 * `p0 -> p1` runs across the slope at the wall line, low end first.
 */
export function leanEnd(b, { p0, p1, y0, y1, style, tint = TINT.timber }) {
  if (y1 - y0 < 0.02) return
  const layer = style === WALL_STYLE.LOG ? LAYER.TIMBER_HEWN : LAYER.TIMBER_PLANK
  b.tri(
    [p0[0], y0, p0[1]],
    [p1[0], y0, p1[1]],
    [p1[0], y1, p1[1]],
    { layer, vWorldY: true, color: tint, double: true }
  )
}

// --- openings ---------------------------------------------------------------
//
// NOTHING IS EVER BOOLEAN-CUT OUT OF A WALL. Openings are built as surrounds
// that stand PROUD of the wall face, with the leaf or the glass set inside
// them. That is not a shortcut: cutting a hole would leave a boundary edge, and
// the collapse decimator refuses to collapse edges that border a hole, which is
// exactly why the existing props stall at 896 -> 544 triangles and never reach
// target. Buildings LOD by re-generation at lower detail instead, and keeping
// every wall a closed quad is what keeps that option open.

/**
 * A door: surround, plank leaf, ironwork, and an optional carved lintel.
 *
 * `nx, nz` is the outward wall normal; the door is placed on the wall face at
 * `(x, z)`. On the front wall of a building that is (0, 1), because the door is
 * always on local +Z.
 */
export function doorway(
  b,
  { x, z, y0, nx, nz, width = 1.0, height = 1.95, runes = false, detail = 2 }
) {
  const tx = -nz // along the wall
  const tz = nx
  const hw = width / 2
  const p = (alongT, y, out) => [
    x + tx * alongT + nx * out,
    y,
    z + tz * alongT + nz * out,
  ]

  // The leaf, set just proud of the wall so it never z-fights it.
  //
  // ONE quad, addressed 0..1 off the DOOR layer rather than tiled off
  // TIMBER_PLANK. The layer is a photograph of a whole door -- boards, straps,
  // ring pull and all -- so this quad now carries what used to take three more
  // doubled decal quads on top of it, and a door leaf costs four triangles
  // instead of sixteen. It is also the only thing on a building that is not
  // world-scaled, which is correct: a door is a size, not a pattern.
  const leafOut = 0.03
  b.quad(
    p(-hw, y0, leafOut), p(hw, y0, leafOut), p(hw, y0 + height, leafOut), p(-hw, y0 + height, leafOut),
    { layer: LAYER.DOOR, island: { u0: 0, v0: 0, u1: 1, v1: 1 }, color: TINT.timber, double: true }
  )
  if (detail < 2) return

  // Surround: two jambs and a lintel, standing proud of both wall and leaf.
  const jw = 0.13
  const out = 0.11
  const jamb = (s) => {
    const a = p(s * (hw + jw / 2), y0, 0)
    b.box(
      [Math.min(a[0], a[0] + nx * out) - (tx ? jw / 2 : 0.06), y0, Math.min(a[2], a[2] + nz * out) - (tz ? jw / 2 : 0.06)],
      [Math.max(a[0], a[0] + nx * out) + (tx ? jw / 2 : 0.06), y0 + height + jw, Math.max(a[2], a[2] + nz * out) + (tz ? jw / 2 : 0.06)],
      { layer: LAYER.TIMBER_HEWN, color: TINT.timberDark }
    )
  }
  jamb(-1)
  jamb(1)
  const l0 = p(-(hw + jw), y0 + height, 0)
  const l1 = p(hw + jw, y0 + height, 0)
  b.box(
    [Math.min(l0[0], l1[0], l0[0] + nx * out, l1[0] + nx * out) - 0.001, y0 + height, Math.min(l0[2], l1[2], l0[2] + nz * out, l1[2] + nz * out) - 0.001],
    [Math.max(l0[0], l1[0], l0[0] + nx * out, l1[0] + nx * out) + 0.001, y0 + height + jw + 0.06, Math.max(l0[2], l1[2], l0[2] + nz * out, l1[2] + nz * out) + 0.001],
    { layer: LAYER.TIMBER_HEWN, color: TINT.timberDark }
  )

  // No ironwork quads here any more. The two hinge straps and the ring pull
  // used to be three doubled decals off IRON_ISLANDS; they are now texels in
  // the DOOR layer, which is strictly better -- twelve fewer triangles, and a
  // strap that is photographed rather than painted with two gradients. IRON is
  // still used by the shutters in windowUnit(), so the sheet is not dead.

  if (runes) {
    const ly = y0 + height + jw + 0.005
    b.quad(
      p(-(hw + jw), ly, out * 0.5), p(hw + jw, ly, out * 0.5),
      p(hw + jw, ly + 0.055, out * 0.5), p(-(hw + jw), ly + 0.055, out * 0.5),
      { layer: LAYER.RUNE, island: RUNE_ISLANDS.lintelBand, color: TINT.timber, double: true }
    )
  }
}

/**
 * A rectangular ring with a rectangular hole, extruded: a picture frame.
 *
 * Both rectangles are given in the caller's flat 2D frame as [a0, v0, a1, v1],
 * and `p(a, y0 + v, out)` lifts them into the world -- so this works for any
 * wall orientation without knowing anything about one.
 *
 * The four surfaces are the front ring, the back ring, the outer skirt and the
 * inner reveal, four quads each, and together they close a solid. Nothing is
 * doubled and nothing needs to be: a closed solid pairs its own edges, which is
 * the whole reason to prefer this over a ring of four flat quads.
 *
 * Windings below are derived, not eyeballed. Note that (a, v, out) is a LEFT
 * handed frame -- p()'s tangent is (-nz, 0, nx), and t x up = -n -- so the
 * ordering that looks anticlockwise when you sketch it faces INTO the wall.
 */
function frameRing(b, { p, y0, outer, inner, back, front, layer, color }) {
  const ring = ([a0, v0, a1, v1], out) => [
    p(a0, y0 + v0, out), p(a1, y0 + v0, out), p(a1, y0 + v1, out), p(a0, y0 + v1, out),
  ]
  const Of = ring(outer, front)
  const Ob = ring(outer, back)
  const If = ring(inner, front)
  const Ib = ring(inner, back)
  const o = { layer, color }
  for (let k = 0; k < 4; k++) {
    const j = (k + 1) % 4
    b.quad(If[k], If[j], Of[j], Of[k], o) // front ring, facing out
    b.quad(Ob[k], Ob[j], Ib[j], Ib[k], o) // back ring, facing into the wall
    b.quad(Of[k], Of[j], Ob[j], Ob[k], o) // outer skirt
    b.quad(Ib[k], Ib[j], If[j], If[k], o) // inner reveal, facing into the hole
  }
}

/**
 * A window as a shallow box standing out of the wall, glass on its outer face.
 *
 * The frame is what gives a window depth in silhouette against the sky, which a
 * flat quad on the wall never does.
 */
export function windowUnit(
  b,
  { x, z, y0, nx, nz, width = 0.7, height = 0.85, shutters = false, detail = 2 }
) {
  const tx = -nz
  const tz = nx
  const hw = width / 2
  const depth = 0.14
  const frame = 0.07
  const p = (a, y, out) => [x + tx * a + nx * out, y, z + tz * a + nz * out]

  // Glass, at the outer face of the reveal.
  b.quad(
    p(-hw, y0, depth), p(hw, y0, depth), p(hw, y0 + height, depth), p(-hw, y0 + height, depth),
    { layer: LAYER.GLASS, vWorldY: true, color: TINT.glass, double: true }
  )
  if (detail < 2) return

  // The surround, as ONE mitred ring rather than four overlapping boxes.
  //
  // Four boxes cost 48 triangles and the inn carries fifteen windows, which is
  // 720 triangles of surround on a 1800-triangle budget -- by a wide margin the
  // most expensive thing on the building, spent on eight faces per stick that
  // are buried inside the neighbouring stick. The ring is 32, has proper mitred
  // corners instead of a lap joint, and is still a closed solid.
  const ow = hw + frame
  frameRing(b, {
    p, y0,
    outer: [-ow, -frame, ow, height + frame],
    inner: [-hw, 0, hw, height],
    back: 0, front: depth + 0.02,
    layer: LAYER.TIMBER_PLANK, color: TINT.timberDark,
  })

  if (shutters) {
    const sd = depth + 0.03
    for (const s of [-1, 1]) {
      const a0 = s < 0 ? -ow - width * 0.52 : ow
      b.quad(
        p(a0, y0, sd), p(a0 + width * 0.52, y0, sd),
        p(a0 + width * 0.52, y0 + height, sd), p(a0, y0 + height, sd),
        { layer: LAYER.TIMBER_PLANK, vWorldY: true, color: TINT.timberDark, double: true }
      )
      b.quad(
        p(a0 + 0.02, y0 + height * 0.62, sd + 0.006), p(a0 + width * 0.5, y0 + height * 0.62, sd + 0.006),
        p(a0 + width * 0.5, y0 + height * 0.62 + 0.1, sd + 0.006), p(a0 + 0.02, y0 + height * 0.62 + 0.1, sd + 0.006),
        { layer: LAYER.IRON, island: IRON_ISLANDS.shutterStrap, color: TINT.iron, double: true }
      )
    }
  }
}

/**
 * A stone chimney rising through a roof slope.
 *
 * `baseY` must be the roof surface height at (x, z), which the plan works out
 * from the roof it is piercing -- a chimney whose base floats above the slope
 * or sinks below it is the most obvious possible generation bug, and
 * scripts/check-buildings.mjs asserts against exactly that.
 */
export function chimney(b, { x, z, baseY, topY, w = 0.62, d = 0.62, detail = 2 }) {
  const grime = groundGrime(baseY, 1.4, 0.22)
  b.box(
    [x - w / 2, baseY - 0.35, z - d / 2],
    [x + w / 2, topY, z + d / 2],
    { layer: LAYER.STONE, color: grime }
  )
  if (detail < 2) return
  // A corbelled cap: the courses step out at the top, which is both how a
  // chimney is actually built and what stops it reading as a plain post.
  const o = 0.09
  b.box(
    [x - w / 2 - o, topY - 0.16, z - d / 2 - o],
    [x + w / 2 + o, topY, z + d / 2 + o],
    { layer: LAYER.STONE, color: TINT.stone }
  )
}

/**
 * A porch: two posts, a lean-to roof over the door, and a rail on each side.
 *
 * Earns its place because it is generated from TERRAIN rather than from a
 * style knob -- the plan raises a porch where the plinth is tall enough to need
 * steps, so a village on a slope grows porches and a village on the flat does
 * not, and the variation is free and correct.
 */
export function porch(b, { x, z, floorY, groundY = null, width = 2.0, depth = 1.3, headY, detail = 2 }) {
  const hw = width / 2
  const z1 = z + depth
  // The deck, as boarding on a rubble footing rather than a floating rectangle.
  //
  // The deck used to be one quad: no bottom, no edge, nothing holding it up, so
  // from anywhere below the doorstep it vanished and the posts stood on air.
  // A porch is the one part of a building people walk right up to, and the two
  // things that make it read as built are that the boards have an edge you can
  // see the thickness of, and that something carries them to the ground.
  const deckT = 0.14
  b.box(
    [x - hw, floorY - deckT, z], [x + hw, floorY, z1],
    { layer: LAYER.TIMBER_PLANK, color: TINT.timber }
  )
  const base = groundY ?? floorY - deckT - 0.4
  if (base < floorY - deckT - 0.02) {
    b.box(
      [x - hw + 0.07, base, z + 0.07], [x + hw - 0.07, floorY - deckT, z1 - 0.07],
      { layer: LAYER.STONE, color: groundGrime(base, 0.9, 0.32) }
    )
  }
  const roof = leanToRoof(b, {
    cx: x, cz: z + depth / 2, w: width + 0.3, d: depth,
    highY: headY, lowY: headY - 0.34, dir: '+z', overhang: 0.18,
    layer: LAYER.SHINGLE, tint: TINT.shake, detail,
  })
  if (detail < 2) return roof
  for (const s of [-1, 1]) {
    const px = x + s * (hw - 0.1)
    b.box(
      [px - 0.08, floorY, z1 - 0.16], [px + 0.08, headY - 0.3, z1],
      { layer: LAYER.TIMBER_HEWN, color: TINT.timberDark }
    )
    // Rail along the open side.
    b.box(
      [Math.min(px - 0.05, x + s * hw - 0.05), floorY + 0.82, z + 0.05],
      [Math.max(px + 0.05, x + s * hw + 0.05), floorY + 0.92, z1 - 0.05],
      { layer: LAYER.TIMBER_PLANK, color: TINT.timberDark }
    )
  }
  return roof
}

/** Steps down from a doorway to the ground, one box a tread. */
export function steps(b, { x, z, topY, groundY, width = 1.4, tread = 0.3 }) {
  const rise = topY - groundY
  if (rise < 0.12) return
  const n = Math.max(1, Math.round(rise / 0.19))
  const hw = width / 2
  for (let i = 0; i < n; i++) {
    const y = topY - (rise * (i + 1)) / n
    const z0 = z + tread * i
    b.box(
      [x - hw, y, z0], [x + hw, y + rise / n + 0.02, z0 + tread * 1.05],
      { layer: LAYER.STONE, color: groundGrime(groundY, 0.8, 0.3) }
    )
  }
}
