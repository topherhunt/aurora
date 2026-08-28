import THREE from '../three-instance.js'
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

const lerp = (a, b, t) => a + (b - a) * t

const WHITE = [1, 1, 1]

/**
 * A STATELESS hash, deliberately, where the obvious thing is a seeded stream.
 *
 * Everything rough-hewn in this kit is jittered off a hash of (seed, index).
 * A running PRNG would do the same job until the day somebody adds a part in
 * the middle of a function, at which point every draw after it shifts and the
 * whole village silently re-rolls. Indexing by hand means a member's shape
 * depends on that member and nothing else.
 */
export function hash(seed, i) {
  let h = Math.imul((seed | 0) ^ 0x9e3779b9, 2654435761) ^ Math.imul((i | 0) + 1, 0x85ebca6b)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  return (h >>> 0) / 4294967296
}

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
   *  Takes `double` and `uvs` on the same terms as quad(). */
  tri(a, b, c, o) {
    const layer = o.layer
    const tile = o.tile ?? TILE_METRES[layer] ?? 1
    const n = unit(cross(sub(b, a), sub(c, a)))

    let uvAt
    if (o.uvs) {
      const map = new Map([[a, o.uvs[0]], [b, o.uvs[1]], [c, o.uvs[2]]])
      uvAt = (p) => map.get(p)
    } else {
      const origin = o.origin ?? a
      const uh = unit(sub(b, a))
      const raw = sub(c, a)
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

  /**
   * A closed prism: the cross-section `section` swept from `a` to `bEnd`.
   *
   * THIS IS THE PART THAT MAKES THE KIT LOOK HEWN RATHER THAN SAWN. Every
   * timber in a Nordic building was shaped with an axe against the grain of a
   * tree that was never straight, and the single thing that says so is that its
   * section is not a rectangle: five to seven faces, no two the same width, no
   * corner a right angle. A box says "extruded", and no texture argues it out
   * of that -- the silhouette is decided before the sampler is reached.
   *
   * `section` is a closed loop of [u, v] in the plane perpendicular to the
   * sweep, anticlockwise looking back down the axis, and roughSection() below
   * is what produces one. Costs 4n-4 triangles against a box's 12, so a
   * six-sided member is 20; that is the price of the whole look and it is only
   * paid at detail 2.
   *
   * U runs AROUND the section and V along the sweep -- except when
   * `uAlongAxis`, which swaps them, and which almost every member wants. The
   * beam tile is a photograph of a log lying down, so its grain runs along U;
   * a standing post's grain runs along its own axis, and swapping is how one
   * tile serves both without a second layer.
   */
  prism(a, bEnd, section, o) {
    const axis = sub(bEnd, a)
    const len = Math.hypot(axis[0], axis[1], axis[2])
    if (len < 1e-6 || section.length < 3) return this
    const w = [axis[0] / len, axis[1] / len, axis[2] / len]
    // Any reference not parallel to the axis. Which one only rotates the
    // section inside its own plane, and the jitter makes that meaningless.
    const ref = Math.abs(w[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]
    const uh = unit(cross(ref, w))
    const vh = cross(w, uh) // unit already: w and uh are unit and perpendicular
    const n = section.length
    const layer = o.layer
    const tile = o.tile ?? TILE_METRES[layer] ?? 1
    const opts = { layer, color: o.color, tile }

    // `sectionEnd` lets the far end differ, which is how a chimney batters in
    // toward its top without a second solid stacked on the first. It must be
    // the SAME loop scaled, not a re-roll: re-rolling the corner angles twists
    // the facets, and a twisted post reads as a modelling error rather than as
    // a hand-shaped one.
    const end = o.sectionEnd ?? section
    const at = (origin, sec, k) => [
      origin[0] + uh[0] * sec[k][0] + vh[0] * sec[k][1],
      origin[1] + uh[1] * sec[k][0] + vh[1] * sec[k][1],
      origin[2] + uh[2] * sec[k][0] + vh[2] * sec[k][1],
    ]
    const A = []
    const B = []
    for (let k = 0; k < n; k++) { A.push(at(a, section, k)); B.push(at(bEnd, end, k)) }

    // Arc length around the section, carried past the wrap rather than reset to
    // zero, so the texture runs continuously around the member.
    const perim = [0]
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n
      perim.push(perim[k] + Math.hypot(section[j][0] - section[k][0], section[j][1] - section[k][1]))
    }
    const frame = (around, along) =>
      o.uAlongAxis ? [along / tile, around / tile] : [around / tile, along / tile]
    // `vWorldY` measures the sweep in absolute world height, so a standing post
    // courses in with the wall behind it exactly as box() does.
    const along = (p, d) => (o.vWorldY ? p[1] : d)

    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n
      this.quad(A[k], A[j], B[j], B[k], {
        ...opts,
        uvs: [
          frame(perim[k], along(A[k], 0)),
          frame(perim[k + 1], along(A[j], 0)),
          frame(perim[k + 1], along(B[j], len)),
          frame(perim[k], along(B[k], len)),
        ],
      })
    }
    // The two end caps, as fans. They are end grain and are usually buried in a
    // wall, but a prism without them is not a solid and openEdges() says so.
    const cap = (k) => [section[k][0] / tile, section[k][1] / tile]
    for (let k = 1; k < n - 1; k++) {
      this.tri(A[0], A[k + 1], A[k], { ...opts, uvs: [cap(0), cap(k + 1), cap(k)] })
      this.tri(B[0], B[k], B[k + 1], { ...opts, uvs: [cap(0), cap(k), cap(k + 1)] })
    }
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
  // SHINGLE, tinted to NEUTRAL -- this is the whole "slate roof", and the
  // numbers are measured rather than picked. A vertex colour multiplies; it
  // cannot desaturate. Grey in means brown out, because shingle.png's own mean
  // is linear [0.117, 0.089, 0.069] -- half again as much red as blue -- and a
  // neutral multiply carries all of that straight through. That is why the old
  // cold tint still read as wood: it took the mean to [0.061, 0.050, 0.044],
  // which is still 1.4:1 red to blue and still a plank.
  //
  // So the tint is the INVERSE of the tile's own chroma, scaled to the value
  // wanted: 0.0385 / [0.117, 0.089, 0.069] lands the mean on a neutral grey a
  // quarter darker in luminance than the old tint left it. Per-texel chroma
  // survives, which is right -- slate is not one colour either.
  slate: [0.33, 0.43, 0.56],
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

/**
 * A rough cross-section: `n` corners, none of them square, none of them evenly
 * spaced, all of them a deterministic function of `seed`.
 *
 * `round` blends between the rectangle `hu x hv` (0) and the ellipse inscribed
 * in it (1), which is the difference between a squared-off beam and a log with
 * the bark still on. `jitter` then moves each corner in or out, which is what
 * stops five of them reading as a pentagon.
 *
 * Corner ANGLES are jittered by less than half their own spacing, so they can
 * never cross and the loop stays wound anticlockwise -- prism()'s cap fans and
 * the outward winding of its sides both depend on that.
 */
export function roughSection(n, hu, hv, seed, { jitter = 0.18, round = 0.55 } = {}) {
  const pts = []
  const spin = (hash(seed, 91) - 0.5) * ((Math.PI * 2) / n)
  const j = Math.min(jitter, 0.22)
  for (let k = 0; k < n; k++) {
    const th = spin + ((Math.PI * 2) * (k + (hash(seed, k * 3 + 1) - 0.5) * 0.5)) / n
    const c = Math.cos(th)
    const s = Math.sin(th)
    // Where this direction leaves the rectangle, and where it leaves the ellipse.
    const t = Math.min(hu / Math.max(Math.abs(c), 1e-4), hv / Math.max(Math.abs(s), 1e-4))
    const g = 1 + (hash(seed, k * 3 + 2) - 0.5) * 2 * j
    pts.push([lerp(t * c, hu * c, round) * g, lerp(t * s, hv * s, round) * g])
  }
  return pts
}

/**
 * One rough member -- a post, a beam, a rail, a log end -- from `a` to `bEnd`.
 *
 * The number of sides is drawn from the seed too, between 5 and 7. A kit whose
 * every timber has six faces is a kit whose every timber came from the same
 * function, and at LOD0 that is visible even when the jitter is not.
 */
export function member(b, a, bEnd, o) {
  const seed = o.seed ?? 0
  const sides = o.sides ?? 5 + Math.floor(hash(seed, 77) * 3)
  const hv = o.hv ?? o.hu
  const shape = { jitter: o.jitter, round: o.round }
  const section = roughSection(sides, o.hu, hv, seed, shape)
  const taper = o.taper ?? 1
  return b.prism(a, bEnd, section, {
    sectionEnd: taper === 1 ? null : roughSection(sides, o.hu * taper, hv * taper, seed, shape),
    layer: o.layer ?? LAYER.TIMBER_BEAM,
    color: o.color ?? TINT.timber,
    tile: o.tile,
    uAlongAxis: o.uAlongAxis ?? true,
    vWorldY: o.vWorldY ?? false,
  })
}

/**
 * A slab with irregularly broken edges -- a plinth, a doorstep, a porch deck.
 *
 * A box reads as machined no matter what texture is on it, and a slab is the one
 * part of a building the player's feet are level with. So the top arris (and the
 * bottom, where it is not buried) is knocked off by a chamfer whose depth is
 * drawn per corner AND per axis: the four corners of a split stone are never
 * broken by the same amount, and a uniform 45 degrees is just a smaller machine.
 * The shoulder heights are jittered on the same terms, which is what turns a
 * chamfer into a break.
 *
 * `batter` spreads the bottom outward, which is what plinth() has always done.
 * Horizontal extent is measured at the TOP, so lo/hi are the top footprint and
 * the bottom flares out from it. The rings, bottom up:
 *
 *   y0            bottom face, inset per corner     <- omitted if !bevelBottom
 *   y0 + bev_k    full extent + batter
 *   y1 - bev_k    full extent
 *   y1            top face, inset per corner
 *
 * 28 triangles, or 20 with the bottom buried, against a box's 12.
 *
 * WINDING: the corner order is CLOCKWISE seen from above, because a side quad's
 * normal is (ring tangent) x up -- anticlockwise gives four inward faces and a
 * shell that balances every edge while being inside out. See openEdges().
 */
export function roughSlab(b, lo, hi, o) {
  const { seed = 0, layer, color, batter = 0, bevelBottom = true, tile } = o
  const hw = (hi[0] - lo[0]) / 2
  const hd = (hi[2] - lo[2]) / 2
  const cx = (lo[0] + hi[0]) / 2
  const cz = (lo[2] + hi[2]) / 2
  const h = hi[1] - lo[1]
  const bev = Math.min(o.bevel ?? 0.05, hw * 0.35, hd * 0.35, h * 0.4)
  if (bev < 1e-3) return b.box(lo, hi, { layer, color, tile })

  const S = [[-1, -1], [-1, 1], [1, 1], [1, -1]] // clockwise from above
  const k = (i) => 0.3 + hash(seed, i) * 0.7
  const spread = (y) => batter * (1 - (y - lo[1]) / (h || 1))
  /** A full-extent ring, pulled `dir * bev_k` off `yBase` corner by corner. */
  const shoulder = (yBase, dir) => S.map(([sx, sz], i) => {
    const y = yBase + dir * bev * k(i * 3 + 2)
    const sp = spread(y)
    return [cx + sx * (hw + sp), y, cz + sz * (hd + sp)]
  })
  /** A face ring at `y`, inset per corner and per axis. */
  const face = (y) => S.map(([sx, sz], i) => {
    const sp = spread(y)
    return [
      cx + sx * (hw + sp - bev * k(i * 3)),
      y,
      cz + sz * (hd + sp - bev * k(i * 3 + 1)),
    ]
  })

  const rings = bevelBottom
    ? [face(lo[1]), shoulder(lo[1], 1), shoulder(hi[1], -1), face(hi[1])]
    : [shoulder(lo[1], 0), shoulder(hi[1], -1), face(hi[1])]
  // vWorldY on the sides so a plinth's courses line up all the way round; NOT on
  // the caps, where a constant V would smear one row of pixels across the whole
  // footprint.
  const side = { layer, color, tile, vWorldY: true }
  const cap = { layer, color, tile }
  for (let r = 0; r < rings.length - 1; r++) {
    const lower = rings[r]
    const upper = rings[r + 1]
    for (let c = 0; c < 4; c++) {
      const cn = (c + 1) % 4
      b.quad(lower[c], lower[cn], upper[cn], upper[c], side)
    }
  }
  const t = rings[rings.length - 1]
  b.quad(t[0], t[1], t[2], t[3], cap)
  const u = rings[0]
  b.quad(u[3], u[2], u[1], u[0], cap)
  return b
}

/** Wall styles. One is chosen per BUILDING, not per wall: mixing them makes a
 *  building read as several buildings pushed together. */
export const WALL_STYLE = {
  LOG: 'log', // horizontal round-log courses, notched ends at the corners
  STAVE: 'stave', // vertical planks between corner posts
  HALF_TIMBER: 'halfTimber', // plaster panels in an exposed frame
  STONE_BASE: 'stoneBase', // masonry to sill height, timber above
  MASONRY: 'masonry', // rubble stone the whole way up, quoined at the corners
}

/**
 * A rubble plinth.
 *
 * `bottom` is deliberately a separate argument from `top` rather than a height:
 * the plan samples the terrain at all four footprint corners, sets the floor at
 * the HIGHEST of them and grows the plinth down to the LOWEST, so a building on
 * a slope gets a tall plinth on the downhill side and cannot ever float. The
 * batter (the slight inward lean) is what stops it reading as a cardboard box.
 *
 * The top arris is broken irregularly by roughSlab(): the ledge the walls stand
 * on is at eye level for nothing and at FOOT level for everyone, and a crisp
 * 90-degree edge there is the first thing that gives the building away. The
 * sole is buried in the hill and gets no chamfer at all -- 8 triangles of stone
 * nobody can see is 8 triangles the roof wanted.
 */
export function plinth(
  b, { cx, cz, w, d, top, bottom, batter = 0.05, seed = 0, tint = TINT.stone, bevel = 0.05 }
) {
  const grime = groundGrime(bottom, 1.1, 0.3)
  const color = (p) => {
    const g = grime(p)
    return [g[0] * tint[0], g[1] * tint[1], g[2] * tint[2]]
  }
  roughSlab(b,
    [cx - w / 2, bottom, cz - d / 2], [cx + w / 2, top, cz + d / 2],
    { seed, batter, bevel, bevelBottom: false, layer: LAYER.STONE, color })
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
export function wall(b, { p0, p1, y0, y1, style, seed = 0, rough = 0, sillY, detail = 2, tint = TINT.timber }) {
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

  if (style === WALL_STYLE.MASONRY) {
    // v1's control version of the style: the texture and nothing else. The
    // quoins that make it read as built rather than as printed are v2's.
    face(y0, y1, LAYER.STONE, groundGrime(y0, 1.2, 0.3))
    return
  }

  if (style === WALL_STYLE.STONE_BASE) {
    face(y0, split, LAYER.STONE, groundGrime(y0, 1.0, 0.28))
    face(split, y1, LAYER.TIMBER_PLANK, tint)
    // The offset course where the timber sits back on the masonry.
    //
    // This was a doubled quad standing 0.06 proud of the wall with NOTHING
    // between its two faces: from anywhere near its own height it was a blade
    // with no thickness, and on a stone building that is the one edge the eye
    // goes to. It is a swept member now, so it has a section, a broken top
    // arris and a shadow. Five sides, 16 triangles, and it runs 0.05 past each
    // corner so the courses of two walls meet instead of leaving a notch.
    if (detail >= 2) {
      const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1
      const ex = ((p1[0] - p0[0]) / L) * 0.05
      const ez = ((p1[1] - p0[1]) / L) * 0.05
      // Horizontal sweep along a wall: the section's u is the wall normal and
      // its v is world up. Centred 0.018 out, so it projects 0.068 and buries
      // its back inside the wall plane rather than hanging off it.
      const out = 0.018
      member(b,
        [p0[0] - ex + nx * out, split, p0[1] - ez + nz * out],
        [p1[0] + ex + nx * out, split, p1[1] + ez + nz * out],
        {
          hu: 0.05, hv: 0.045, sides: 5, seed: rough * 23 + 9,
          round: 0.3, jitter: 0.2, layer: LAYER.STONE, color: TINT.stone,
        })
    }
    return
  }

  if (style === WALL_STYLE.HALF_TIMBER) {
    face(y0, y1, LAYER.PLASTER, groundGrime(y0, y1 - y0, 0.34))
    if (detail < 2) return
    // The frame, standing proud of the plaster. Sill, head, and one post per bay
    // boundary -- which is what actually tells the eye "half-timbered", far more
    // than the plaster does.
    //
    // Every one of them is a rough prism rather than a box: these are the
    // members closest to the eye on a half-timbered wall, and a right-angled
    // frame on a hand-daubed panel is the single thing that says "generated".
    const t = 0.075 // how far the timber stands out
    const w = 0.16 // member width
    const beam = { layer: LAYER.TIMBER_BEAM, color: TINT.timberDark, vWorldY: true }
    const rail = (ya, yb, k) =>
      member(b, [p0[0], (ya + yb) / 2, p0[1]], [p1[0], (ya + yb) / 2, p1[1]],
        { hu: t, hv: (yb - ya) / 2, seed: rough * 17 + k, round: 0.35, ...beam })
    rail(y0, y0 + w, 1)
    rail(y1 - w, y1, 2)
    // `i < bays`, not `i <= bays`: a wall owns the post at its START corner and
    // leaves the one at its end to the wall that starts there. Closing the loop
    // at both ends put TWO independently jittered posts inside each corner of
    // every mass -- eight buried, interpenetrating members on a half-timbered
    // inn, 160 triangles of nothing.
    const bays = Math.max(1, Math.round(len / 1.5))
    for (let i = 0; i < bays; i++) {
      const s = i / bays
      const px = p0[0] + dx * s
      const pz = p0[1] + dz * s
      // The section's u axis is +z and its v axis is +x (see prism), so which
      // half-extent is which depends on the wall's direction.
      member(b, [px, y0 + w, pz], [px, y1 - w, pz], {
        hu: ux ? t : w / 2, hv: ux ? w / 2 : t,
        seed: rough * 17 + 10 + i, round: 0.35, ...beam,
      })
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
      member(b, [px, y0, pz], [px, y1 + 0.04, pz], {
        hu: 0.115, seed: rough * 17 + 30 + t, round: 0.5,
        layer: LAYER.TIMBER_BEAM, color: TINT.timberDark, vWorldY: true,
      })
    }
    return
  }

  // WALL_STYLE.LOG
  face(y0, y1, LAYER.TIMBER_BEAM, tint)
  if (detail < 2) return

  // Notched log ends poking past the corner. This is the silhouette of a log
  // cabin and nothing else in the kit supplies it -- the flat texture alone
  // reads as painted-on stripes. Only every other course sticks out on a given
  // wall, because the courses interlock: the ones between belong to the wall
  // running the other way.
  // Each end is a ROUND prism, not a box, and this is the single best return on
  // triangles anywhere in the kit: a log end is seen against the sky at every
  // corner of the building, at eye level, from a metre away. Six or seven faces
  // with the radius jittered is a log; four is a fence post.
  const course = TILE_METRES[LAYER.TIMBER_BEAM] / 2
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
      member(b,
        [px - ux * out * 0.02, y, pz - uz * out * 0.02],
        [px + ux * out * stick, y, pz + uz * out * stick],
        { hu: r, seed: rough * 17 + 40 + k * 2 + t, round: 0.95, jitter: 0.14, color: tint }
      )
    }
  }
}

/**
 * The triangle of wall between the eave and the ridge at a gable end.
 * `p0 -> p1` runs along the base with the same winding rule as wall().
 */
export function gableEnd(b, { p0, p1, y0, apexY, style, seed = 0, tint = TINT.timber, detail = 2 }) {
  const layer =
    style === WALL_STYLE.LOG ? LAYER.TIMBER_BEAM : LAYER.TIMBER_PLANK
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
  member(b, [mx, y0, mz], [mx, apexY - 0.12, mz], {
    hu: 0.095, seed, round: 0.6, layer: LAYER.TIMBER_BEAM, color: TINT.timberDark, vWorldY: true,
  })
}

/**
 * How thick a roof of each covering is, in metres, and how far its cut edge
 * bulges out past the plane.
 *
 * A thatched roof is a HALF-METRE of packed straw, which is the number that
 * matters most in this table: the thickness of the eave is the single loudest
 * thing about a thatched cottage, and 0.3 m read as a heavy shingle roof rather
 * than as thatch. A shake roof is a board and a shake and stays thin.
 *
 * `bulge` is how far the middle of that cut edge stands proud of the two faces
 * it joins, and it only does anything when the edge is built as more than one
 * band -- see roofPlane().
 */
const ROOF_EDGE = {
  [LAYER.THATCH]: { thick: 0.46, bulge: 0.075 },
  [LAYER.SHINGLE]: { thick: 0.14, bulge: 0.025 },
  [LAYER.ROOF_TILE]: { thick: 0.15, bulge: 0.03 },
}
const DEFAULT_EDGE = { thick: 0.12, bulge: 0.02 }

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
 *
 * THE CUT EDGE IS BUILT IN `rounds` BANDS, not one, and that is what makes a
 * thatched eave read as a rolled half-metre of straw instead of a slab with a
 * dark stripe down it. One band is a plumb cut and looks it. Two or three, with
 * the joins between them pushed out past the plane by `bulge`, give the edge a
 * silhouette that curves -- and the silhouette is the whole of it, because
 * against the sky the eave is the only part of the roof you see edge-on.
 *
 * The bulge is applied per corner in the plane's OWN axes, and the ridge end
 * gets a fraction of what the eave end does. Pushing the ridge corners out by
 * the full amount drives each slope through the other above the ridge line,
 * where only the capping hides it.
 */
function roofPlane(b, corners, t, { layer, color, rounds = 1, bulge = 0 }) {
  const [a, c1, c2, c3] = corners
  const soffit = { layer: LAYER.TIMBER_HEWN, color: TINT.timberDark }

  // Corner order is eave-left, eave-right, ridge-right, ridge-left, so these
  // two are the plane's along-the-eave and up-the-slope directions in XZ, and
  // the signs below say which corner is on which side of each.
  const flat = (p, q) => {
    const dx = q[0] - p[0]
    const dz = q[2] - p[2]
    const l = Math.hypot(dx, dz) || 1
    return [dx / l, dz / l]
  }
  const eaveDir = flat(a, c1)
  const slopeDir = flat(a, c3)
  const SIGNS = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
  const RIDGE_SHARE = 0.3
  const out = SIGNS.map(([sa, sc]) => {
    const w = sc < 0 ? 1 : RIDGE_SHARE
    return [eaveDir[0] * sa + slopeDir[0] * sc * w, eaveDir[1] * sa + slopeDir[1] * sc * w]
  })
  // s = 0 at the top surface, 1 at the soffit. The push is a half sine, so both
  // ends of the profile meet the faces they join without a crease.
  const ring = (s) => {
    const push = bulge * Math.sin(Math.PI * s)
    return corners.map((p, i) => [p[0] + out[i][0] * push, p[1] - t * s, p[2] + out[i][1] * push])
  }

  b.quad(a, c1, c2, c3, { layer, color })
  const bottom = ring(1)
  b.quad(bottom[0], bottom[3], bottom[2], bottom[1], soffit)
  // Winding is (lower-p, lower-q, q, p) for each edge of the loop, which faces
  // outward wherever the top surface faces upward -- true of every plane here.
  let prev = corners
  for (let k = 1; k <= rounds; k++) {
    const cur = k === rounds ? bottom : ring(k / rounds)
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4
      b.quad(cur[i], cur[j], prev[j], prev[i], { layer, color, vWorldY: true })
    }
    prev = cur
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
    seed = 0,
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
  const edge = ROOF_EDGE[layer] ?? DEFAULT_EDGE
  const thick = edge.thick
  // Two bands or three, drawn from the seed. A village where every eave is
  // faceted the same way is a village of one roof, and the cost of the third
  // band is four triangles a slope.
  const rounds = detail >= 2 ? 2 + (hash(seed, 5) < 0.5 ? 1 : 0) : 1
  const bulge = detail >= 2 ? edge.bulge : 0
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
      : [P(1, false), P(0, false), P(0, true), P(1, true)], thick, { layer, color, rounds, bulge })
  }
  slope(1)
  slope(-1)

  if (detail >= 2) {
    // The ridge capping: a rolled bolster along the top, which hides the seam
    // where the two slopes meet and reads as the ridge roll a thatcher pegs on.
    // Round rather than square for the same reason the eave is -- it is the
    // topmost line of the building against the sky, and a square one is a box.
    const t = 0.14
    const y = ridgeY - t * 0.2
    const lo = ridgeAxis === 'x' ? [cx + aLo, y, cz] : [cx, y, cz + aLo]
    const hi = ridgeAxis === 'x' ? [cx + aHi, y, cz] : [cx, y, cz + aHi]
    member(b, lo, hi, {
      hu: t, hv: t * 0.85, seed: seed * 7 + 3, sides: 6, round: 0.85, jitter: 0.1,
      layer, color: tint, uAlongAxis: false,
    })
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
  { cx, cz, w, d, highY, lowY, dir = '+z', seed = 0, overhang = 0.3, layer = LAYER.THATCH, tint = TINT.thatchNew, detail = 2 }
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
  const edge = ROOF_EDGE[layer] ?? DEFAULT_EDGE
  const thick = edge.thick
  const rounds = detail >= 2 ? 2 + (hash(seed, 5) < 0.5 ? 1 : 0) : 1
  const bulge = detail >= 2 ? edge.bulge : 0
  // Eave corners first so V runs up the slope, as on a gable.
  const flip = (axis === 'x') === (sign > 0)
  roofPlane(b, flip
    ? [P(1, true), P(0, true), P(0, false), P(1, false)]
    : [P(0, true), P(1, true), P(1, false), P(0, false)], thick, { layer, color, rounds, bulge })

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
  const layer = style === WALL_STYLE.LOG ? LAYER.TIMBER_BEAM : LAYER.TIMBER_PLANK
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
  { x, z, y0, nx, nz, width = 1.0, height = 1.95, runes = false, seed = 0, detail = 2 }
) {
  const tx = -nz // along the wall
  const tz = nx
  const hw = width / 2
  const p = (alongT, y, out) => [
    x + tx * alongT + nx * out,
    y,
    z + tz * alongT + nz * out,
  ]

  // The leaf, set proud of the wall so it never z-fights it -- and by enough
  // that the wall cannot BELLY through it either. 3 cm cleared the z-buffer and
  // not the warp: a stone-base wall bows about 7 cm at its worst, which put the
  // masonry out through the middle of the door. 8 cm is past that and is still
  // 6 cm behind the front of the jambs, so the leaf stays recessed in its reveal.
  //
  // ONE quad, addressed 0..1 off the DOOR layer rather than tiled off
  // TIMBER_PLANK. The layer is a photograph of a whole door -- boards, straps,
  // ring pull and all -- so this quad now carries what used to take three more
  // doubled decal quads on top of it, and a door leaf costs four triangles
  // instead of sixteen. It is also the only thing on a building that is not
  // world-scaled, which is correct: a door is a size, not a pattern.
  const leafOut = 0.08
  b.quad(
    p(-hw, y0, leafOut), p(hw, y0, leafOut), p(hw, y0 + height, leafOut), p(-hw, y0 + height, leafOut),
    { layer: LAYER.DOOR, island: { u0: 0, v0: 0, u1: 1, v1: 1 }, color: TINT.timber, double: true }
  )
  if (detail < 2) return

  // Surround: two jambs and a lintel, standing proud of both wall and leaf, and
  // all three of them hewn baulks rather than boxes.
  //
  // Their half-extents are stated as "across the wall" and "out of the wall"
  // and then resolved into the section's own axes, because prism() picks its
  // cross-section frame from the sweep direction and that frame is +z, +x for
  // anything standing up and normal, up for anything lying along a wall. The
  // wall normal here is always axis-aligned, so |nx| and |nz| select.
  const jw = 0.14 // across the wall
  const jd = 0.19 // out of the wall
  const jc = 0.05 // where the middle of that depth sits, measured from the face
  const beam = { layer: LAYER.TIMBER_BEAM, color: TINT.timberDark, round: 0.4 }
  const jamb = (s, k) => {
    const a = s * (hw + jw / 2)
    member(b, p(a, y0 - 0.02, jc), p(a, y0 + height + jw, jc), {
      hu: Math.abs(nz) * (jd / 2) + Math.abs(nx) * (jw / 2),
      hv: Math.abs(nx) * (jd / 2) + Math.abs(nz) * (jw / 2),
      seed: seed * 13 + k, vWorldY: true, ...beam,
    })
  }
  jamb(-1, 1)
  jamb(1, 2)
  // The lintel sweeps along the wall, so its section frame is (normal, up). No
  // `vWorldY`: it is horizontal, so world height is the same number at both ends
  // and the tile would be one column of texels smeared down its whole length.
  const ly0 = y0 + height + jw / 2
  member(b, p(-(hw + jw), ly0, jc), p(hw + jw, ly0, jc), {
    hu: jd / 2, hv: jw / 2 + 0.03, seed: seed * 13 + 3, ...beam,
  })

  // No ironwork quads here any more. The two hinge straps and the ring pull
  // used to be three doubled decals off IRON_ISLANDS; they are now texels in
  // the DOOR layer, which is strictly better -- twelve fewer triangles, and a
  // strap that is photographed rather than painted with two gradients. IRON is
  // still used by the shutters in windowUnit(), so the sheet is not dead.

  if (runes) {
    // Carved across the FACE of the lintel, clear of its jitter. It used to sit
    // at half the old lintel's depth, which put it inside the timber.
    const ro = jc + jd / 2 + 0.03
    b.quad(
      p(-(hw + jw * 0.6), ly0 - 0.03, ro), p(hw + jw * 0.6, ly0 - 0.03, ro),
      p(hw + jw * 0.6, ly0 + 0.03, ro), p(-(hw + jw * 0.6), ly0 + 0.03, ro),
      { layer: LAYER.RUNE, island: RUNE_ISLANDS.lintelBand, color: TINT.timber, double: true }
    )
  }
}

/**
 * A picture frame: ONE rough section swept around a mitred rectangular path.
 *
 * The path is given in the caller's flat 2D frame -- `ha`/`hv` are the half
 * extents of its CENTRE LINE about (0, vc), and `p(a, y0 + v, out)` lifts it
 * into the world, so this works for any wall orientation without knowing
 * anything about one. Offsetting a corner by `r` on BOTH axes at once is what
 * makes the mitre: the corner of a rectangle grown by r sits at (ha+r, hv+r).
 *
 * A closed tube has no caps and no boundary, so it is airtight by construction,
 * and the section being the same loop at all four corners is what keeps the
 * mitre a real mitre rather than a lap joint.
 *
 * WINDING IS DERIVED, NOT EYEBALLED. (a, v, out) is a LEFT handed frame --
 * p()'s tangent is (-nz, 0, nx) and t x up = -n -- and for the corner order
 * below the sweep tangent T satisfies T = e_r x e_o. A side quad's normal is
 * T x S for section tangent S, and T x S points outward only when S turns
 * CLOCKWISE in (r, o). roughSection() winds anticlockwise, hence the reverse().
 */
function frameRing(b, { p, y0, ha, hv, vc, width, back, front, seed = 0, sides = 5, layer, color }) {
  const oc = (back + front) / 2
  const sec = roughSection(sides, width / 2, (front - back) / 2, seed, {
    jitter: 0.15, round: 0.3,
  }).reverse()
  const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
  const P = CORNERS.map(([sa, sv]) =>
    sec.map(([r, o]) => p(sa * (ha + r), y0 + vc + sv * (hv + r), oc + o)))
  const o = { layer, color }
  for (let c = 0; c < 4; c++) {
    const cn = (c + 1) % 4
    for (let s = 0; s < sides; s++) {
      const sn = (s + 1) % sides
      b.quad(P[c][s], P[cn][s], P[cn][sn], P[c][sn], o)
    }
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
  { x, z, y0, nx, nz, width = 0.7, height = 0.85, shutters = false, seed = 0, detail = 2 }
) {
  const tx = -nz
  const tz = nx
  const hw = width / 2
  const depth = 0.14
  const frame = 0.07
  const p = (a, y, out) => [x + tx * a + nx * out, y, z + tz * a + nz * out]

  // Glass, set BACK in the reveal rather than flush with the front of the
  // frame. It used to sit at `depth`, 2 cm behind a surround that stands 16 cm
  // out of the wall, so the pane read as glued onto the front of the box. At a
  // third of the depth the frame throws a reveal shadow across it and the window
  // looks like a hole with something in it.
  const glassAt = depth * 0.33
  b.quad(
    p(-hw, y0, glassAt), p(hw, y0, glassAt),
    p(hw, y0 + height, glassAt), p(-hw, y0 + height, glassAt),
    { layer: LAYER.GLASS, vWorldY: true, color: TINT.glass, double: true }
  )
  if (detail < 2) return

  // The surround, as ONE swept ring rather than four overlapping boxes.
  //
  // Four boxes cost 48 triangles and the inn carries fifteen windows, which is
  // 720 triangles of surround on a 2500-triangle budget -- by a wide margin the
  // most expensive thing on the building, spent on eight faces per stick that
  // are buried inside the neighbouring stick. The ring is 8n: five sides is 40
  // for a frame that is round-cornered on every edge, six is 48 for what four
  // boxes bought squared off.
  const ow = hw + frame
  const sides = 5 + Math.floor(hash(seed, 21) * 2)
  frameRing(b, {
    p, y0,
    ha: hw + frame / 2, hv: height / 2 + frame / 2, vc: height / 2,
    width: frame, back: 0, front: depth + 0.02,
    seed: seed * 31 + 7, sides,
    layer: LAYER.TIMBER_PLANK, color: TINT.timberDark,
  })

  if (shutters) {
    // WHERE THE LEAF IS HUNG, which used to be nowhere. The leaf stood at
    // `depth + 0.03` with its inboard edge on the plane of the surround's outer
    // face -- 1 cm in FRONT of that face, so the two never met: the shutter was a
    // rectangle floating clear of the building with daylight all round it. A
    // shutter is the one piece of a window that is obviously hung on something,
    // and it has to touch the thing it is hung on.
    //
    // So the hinged edge is BURIED IN THE SURROUND. It laps `LAP` onto the ring
    // in plan and stands at `HANG` out, which is inside the ring's section --
    // the ring reaches from the wall plane out to `depth + 0.02` -- and stays
    // inside it however the rough section jitters. `HANG` also clears a log
    // course, which stands 5 cm proud of the wall plane.
    const LAP = 0.02
    const HANG = 0.08
    const leafW = width * 0.52
    for (const s of [-1, 1]) {
      // AND SOMETIMES AJAR. A leaf lying flat on the wall is a painted
      // rectangle; what says shutter is the wedge of shadow behind a leaf that
      // has been pushed open. About a third of them get one, per leaf rather
      // than per window, so a window can stand with one leaf back against the
      // wall and the other swung out -- which is what shutters actually look
      // like on a building somebody lives in.
      //
      // A ROTATION about the hinge, not a shear: the free edge swings out and
      // comes in along the wall by the cosine, so the leaf keeps its width. That
      // matters beyond looks -- plan.js reserves `width * 0.52` of frontage for
      // this leaf, and a rotation can only ever need less of it.
      const th = hash(seed * 61, s + 2) < 0.34 ? 0.22 + hash(seed * 61, s + 8) * 0.4 : 0
      const aIn = s * (ow - LAP)
      const aOut = s * (ow - LAP + leafW * Math.cos(th))
      const oOut = HANG + leafW * Math.sin(th)
      b.quad(
        p(aIn, y0, HANG), p(aOut, y0, oOut),
        p(aOut, y0 + height, oOut), p(aIn, y0 + height, HANG),
        { layer: LAYER.TIMBER_PLANK, vWorldY: true, color: TINT.timberDark, double: true }
      )
      // The strap, laid ON the leaf rather than on a plane of its own, or a
      // swung leaf leaves its ironwork hanging in the air behind it.
      const mix = (t, y) => p(aIn + (aOut - aIn) * t, y, HANG + (oOut - HANG) * t + 0.006)
      const sv = y0 + height * 0.62
      b.quad(
        mix(0.04, sv), mix(0.96, sv), mix(0.96, sv + 0.1), mix(0.04, sv + 0.1),
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
export function chimney(b, { x, z, baseY, topY, w = 0.62, d = 0.62, seed = 0, detail = 2 }) {
  const grime = groundGrime(baseY, 1.4, 0.22)
  if (detail < 2) {
    b.box(
      [x - w / 2, baseY - 0.35, z - d / 2],
      [x + w / 2, topY, z + d / 2],
      { layer: LAYER.STONE, color: grime }
    )
    return
  }

  // A chimney is a pile of field stone, not a cast column, so it gets more
  // corners than a timber does and almost none of the rounding: `round` near
  // zero keeps the facets flat and the jitter is what makes their widths
  // haphazard. The batter (the lean inward as it rises) is real masonry
  // practice and reads at any distance the chimney is visible from at all.
  //
  // For a VERTICAL sweep prism()'s section frame is (+z, +x), so the section's
  // u is the world z half-extent and its v is the world x one.
  const sides = 6 + Math.floor(hash(seed, 3) * 3)
  const shape = { jitter: 0.13, round: 0.16 }
  const capY = topY - 0.17
  const batter = 0.86
  const sec = (s) => roughSection(sides, (d / 2) * s, (w / 2) * s, seed, shape)
  b.prism([x, baseY - 0.35, z], [x, capY, z], sec(1), {
    sectionEnd: sec(batter),
    layer: LAYER.STONE, color: grime, vWorldY: true,
  })
  // The corbelled cap: the courses step OUT at the top, which is both how a
  // chimney is built and what stops it reading as a plain post. It reuses the
  // stack's seed so it is the same polygon scaled up -- a re-rolled cap can be
  // locally narrower than the stack it crowns and let a corner poke through.
  const c0 = batter * 1.07
  b.prism([x, capY, z], [x, topY, z], sec(c0), {
    sectionEnd: sec(c0 * 1.34),
    layer: LAYER.STONE, color: TINT.stone, vWorldY: true,
  })
}

/**
 * A porch: two posts, a lean-to roof over the door, and a rail on each side.
 *
 * Earns its place because it is generated from TERRAIN rather than from a
 * style knob -- the plan raises a porch where the plinth is tall enough to need
 * steps, so a village on a slope grows porches and a village on the flat does
 * not, and the variation is free and correct.
 */
export function porch(b, { x, z, floorY, groundY = null, width = 2.0, depth = 1.3, headY, seed = 0, detail = 2 }) {
  const hw = width / 2
  const z1 = z + depth
  // The deck, as boarding on a rubble footing rather than a floating rectangle.
  //
  // The deck used to be one quad: no bottom, no edge, nothing holding it up, so
  // from anywhere below the doorstep it vanished and the posts stood on air.
  // A porch is the one part of a building people walk right up to, and the two
  // things that make it read as built are that the boards have an edge you can
  // see the thickness of, and that something carries them to the ground.
  //
  // Both edges of the deck get broken, not just the top one: a porch is walked
  // onto from ground level, so the underside arris of the boarding is in view
  // the whole way up to it, and a rough-sawn board that is crisp underneath and
  // broken on top reads as a plank with a bug in it.
  const deckT = 0.14
  const deck = [[x - hw, floorY - deckT, z], [x + hw, floorY, z1]]
  const deckO = { layer: LAYER.TIMBER_HEWN, color: TINT.timber }
  if (detail >= 2) {
    roughSlab(b, deck[0], deck[1], { ...deckO, seed: seed * 7 + 31, bevel: 0.03 })
  } else {
    b.box(deck[0], deck[1], deckO)
  }
  const base = groundY ?? floorY - deckT - 0.4
  if (base < floorY - deckT - 0.02) {
    const lo = [x - hw + 0.07, base, z + 0.07]
    const hi = [x + hw - 0.07, floorY - deckT, z1 - 0.07]
    const o = { layer: LAYER.STONE, color: groundGrime(base, 0.9, 0.32) }
    if (detail >= 2) {
      roughSlab(b, lo, hi, { ...o, seed: seed * 7 + 37, bevel: 0.045, bevelBottom: false })
    } else {
      b.box(lo, hi, o)
    }
  }
  const roof = leanToRoof(b, {
    cx: x, cz: z + depth / 2, w: width + 0.3, d: depth,
    highY: headY, lowY: headY - 0.34, dir: '+z', overhang: 0.18,
    layer: LAYER.SHINGLE, tint: TINT.shake, detail,
  })
  if (detail < 2) return roof
  // The posts and rails are the part of a building a player stands closest to,
  // so they are where the hewn section is worth the most and costs the least:
  // two posts and two rails is four members, 80 triangles against the 48 the
  // four boxes cost, for the four silhouettes nobody can avoid looking at.
  for (const s of [-1, 1]) {
    const px = x + s * (hw - 0.1)
    const pz = z1 - 0.08
    member(b, [px, floorY - deckT, pz], [px, headY - 0.3, pz], {
      hu: 0.085, seed: seed * 7 + s + 1, round: 0.4, jitter: 0.2,
      color: TINT.timberDark, vWorldY: true,
    })
    // Rail along the open side. It sweeps horizontally, so vWorldY would hold V
    // constant down its whole length and collapse the texture to a line.
    const rx = x + s * (hw - 0.05)
    member(b, [rx, floorY + 0.87, z + 0.05], [rx, floorY + 0.87, z1 - 0.05], {
      hu: 0.055, hv: 0.048, seed: seed * 7 + s + 5, round: 0.55, jitter: 0.16,
      layer: LAYER.TIMBER_PLANK, color: TINT.timberDark,
    })
  }
  return roof
}

/**
 * Steps down from a doorway to the ground: one broken stone slab a tread, on a
 * pair of raking timber stringers.
 *
 * Each tread box overhangs the one below by a whole tread depth, so the flight
 * used to be a stack of slabs each with clear air under its nose -- correct in
 * section and obviously floating from the side, which is the angle anyone
 * approaching a door sees it from. The stringers are what it stands on.
 */
export function steps(b, { x, z, topY, groundY, width = 1.4, tread = 0.3, seed = 0, detail = 2 }) {
  const rise = topY - groundY
  if (rise < 0.12) return
  const n = Math.max(1, Math.round(rise / 0.19))
  const hw = width / 2
  const step = rise / n
  const grime = groundGrime(groundY, 0.8, 0.3)
  for (let i = 0; i < n; i++) {
    const y = topY - step * (i + 1)
    const z0 = z + tread * i
    const lo = [x - hw, y, z0]
    const hi = [x + hw, y + step + 0.02, z0 + tread * 1.05]
    const o = { layer: LAYER.STONE, color: grime }
    if (detail >= 2) {
      roughSlab(b, lo, hi, { ...o, seed: seed * 13 + i, bevel: 0.035, bevelBottom: false })
    } else {
      b.box(lo, hi, o)
    }
  }
  if (detail < 2) return
  // The stringers, just outboard of the treads and overlapping them by 2 cm so
  // there is no seam to see between the two. A one-riser doorstep gets a
  // shallower stringer than a four-riser flight -- 0.1 deep under a 0.14 rise is
  // a sleeper, not a stair.
  const sh = Math.min(0.1, Math.max(0.045, rise * 0.4))
  for (const s of [-1, 1]) {
    const sx = x + s * (hw + 0.05)
    member(b, [sx, topY - 0.06, z + 0.04], [sx, groundY + 0.05, z + tread * n], {
      hu: 0.07, hv: sh, seed: seed * 13 + 40 + s, round: 0.4, jitter: 0.2,
      color: TINT.timberDark,
    })
  }
}
