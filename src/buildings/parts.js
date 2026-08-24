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
    const i0 = this.vertex(a, n, uvAt(a), layer, tint(a))
    const i1 = this.vertex(b, n, uvAt(b), layer, tint(b))
    const i2 = this.vertex(c, n, uvAt(c), layer, tint(c))
    const i3 = this.vertex(d, n, uvAt(d), layer, tint(d))
    this.idx.push(i0, i1, i2, i0, i2, i3)
    return this
  }

  /** One triangle. Same frame convention: a->b is U, a->c seeds V. */
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
    const i0 = this.vertex(a, n, uvAt(a), layer, tint(a))
    const i1 = this.vertex(b, n, uvAt(b), layer, tint(b))
    const i2 = this.vertex(c, n, uvAt(c), layer, tint(c))
    this.idx.push(i0, i1, i2)
    return this
  }

  /**
   * An axis-aligned box from `min` to `max`.
   *
   * `skip` drops faces by name ('+x','-x','+y','-y','+z','-z'). Dropping the
   * face that is buried in a wall is not a micro-optimisation: a timber frame
   * is dozens of these, and at 2 triangles a face the buried ones are a fifth
   * of a building's budget for something no one can ever see.
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
  // The ledge the walls stand on. No underside: it is buried in the hill.
  b.quad(
    [cx - hw, top, cz + hd], [cx + hw, top, cz + hd],
    [cx + hw, top, cz - hd], [cx - hw, top, cz - hd],
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
  const face = (ya, yb, layer, color) =>
    b.quad(A(0, ya), A(1, ya), A(1, yb), A(0, yb), { layer, vWorldY: true, color })

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
        { layer: LAYER.STONE, color: TINT.stone }
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
        { layer: LAYER.TIMBER_HEWN, color: TINT.timberDark, skip: [nx > 0 ? '-x' : nx < 0 ? '+x' : nz > 0 ? '-z' : '+z'] }
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
        {
          layer: LAYER.TIMBER_HEWN,
          color: tint,
          // The face buried back inside the building is never visible.
          skip: [out > 0 ? (ux ? '-x' : '-z') : ux ? '+x' : '+z'],
        }
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
  b.tri(
    [p0[0], y0, p0[1]],
    [p1[0], y0, p1[1]],
    [mx, apexY, mz],
    { layer, vWorldY: true, color: tint }
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

/**
 * A gable roof over an axis-aligned mass.
 *
 * `ridgeAxis` is 'x' or 'z' and names the axis the RIDGE runs along, so the
 * slopes face the other one. Returns the ridge height, which the chimney and
 * any abutting catslide need.
 */
export function gableRoof(
  b,
  {
    cx, cz, w, d, eaveY, rise,
    ridgeAxis = 'x',
    overhang = 0.4,
    verge = 0.3,
    layer = LAYER.THATCH,
    tint = TINT.thatchNew,
    moss = 0.35,
    fringe = true,
    detail = 2,
  }
) {
  const ridgeY = eaveY + rise
  // Along the ridge, and across it.
  const alongHalf = (ridgeAxis === 'x' ? w : d) / 2 + verge
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
  const slope = (sign) => {
    const P = (alongT, up) => {
      const a = -alongHalf + 2 * alongHalf * alongT
      const acr = sign * (up ? 0 : run)
      const y = up ? ridgeY : eave
      return ridgeAxis === 'x' ? [cx + a, y, cz + acr] : [cx + acr, y, cz + a]
    }
    // Wind so the face points outward on each side.
    if (sign > 0) b.quad(P(0, false), P(1, false), P(1, true), P(0, true), { layer, color })
    else b.quad(P(1, false), P(0, false), P(0, true), P(1, true), { layer, color })
  }
  slope(1)
  slope(-1)

  if (detail >= 2) {
    // The ridge capping: a shallow box along the top, which hides the seam
    // where the two slopes meet and reads as the ridge roll a thatcher pegs on.
    const t = 0.13
    const min = ridgeAxis === 'x'
      ? [cx - alongHalf, ridgeY - t, cz - t]
      : [cx - t, ridgeY - t, cz - alongHalf]
    const max = ridgeAxis === 'x'
      ? [cx + alongHalf, ridgeY + t * 0.7, cz + t]
      : [cx + t, ridgeY + t * 0.7, cz + alongHalf]
    b.box(min, max, { layer, color: tint, skip: ['-y'] })
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
    const uSpan = (2 * alongHalf) / TILE_METRES[LAYER.THATCH_FRINGE]
    for (const sign of [1, -1]) {
      const P = (alongT, y, push) => {
        const a = -alongHalf + 2 * alongHalf * alongT
        const acr = sign * (run + push)
        return ridgeAxis === 'x' ? [cx + a, y, cz + acr] : [cx + acr, y, cz + a]
      }
      // v = 0 at the hanging tip, v = 1 at the eave line -- see tileFringe.
      const uvs = [[0, 0], [uSpan, 0], [uSpan, 1], [0, 1]]
      const lo = eave - dropH
      if (sign > 0) b.quad(P(0, lo, 0.02), P(1, lo, 0.02), P(1, eave, 0), P(0, eave, 0), { layer: LAYER.THATCH_FRINGE, uvs, color: tint })
      else b.quad(P(1, lo, 0.02), P(0, lo, 0.02), P(0, eave, 0), P(1, eave, 0), { layer: LAYER.THATCH_FRINGE, uvs, color: tint })
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
  // Eave corners first so V runs up the slope, as on a gable.
  const flip = (axis === 'x') === (sign > 0)
  if (flip) b.quad(P(1, true), P(0, true), P(0, false), P(1, false), { layer, color })
  else b.quad(P(0, true), P(1, true), P(1, false), P(0, false), { layer, color })

  if (detail >= 1 && layer === LAYER.THATCH) {
    const uSpan = (2 * alongHalf) / TILE_METRES[LAYER.THATCH_FRINGE]
    const uvs = [[0, 0], [uSpan, 0], [uSpan, 1], [0, 1]]
    const E = (alongT, y, push) => {
      const a = -alongHalf + 2 * alongHalf * alongT
      const acr = sign * (run + push)
      return axis === 'x' ? [cx + acr, y, cz + a] : [cx + a, y, cz + acr]
    }
    const lo = eave - 0.3
    if (flip) b.quad(E(1, lo, 0.02), E(0, lo, 0.02), E(0, eave, 0), E(1, eave, 0), { layer: LAYER.THATCH_FRINGE, uvs, color: tint })
    else b.quad(E(0, lo, 0.02), E(1, lo, 0.02), E(1, eave, 0), E(0, eave, 0), { layer: LAYER.THATCH_FRINGE, uvs, color: tint })
  }
  return { eave, run }
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
  const leafOut = 0.03
  b.quad(
    p(-hw, y0, leafOut), p(hw, y0, leafOut), p(hw, y0 + height, leafOut), p(-hw, y0 + height, leafOut),
    { layer: LAYER.TIMBER_PLANK, vWorldY: true, color: TINT.timberDark }
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

  // Ironwork. Two hinge straps and a ring pull, each one quad off the shared
  // sheet -- six triangles for the detail that most says "someone lives here".
  const deco = leafOut + 0.006
  const strap = (yc) => {
    const h = 0.19
    const sw = width * 0.86
    b.quad(
      p(-hw + 0.04, yc - h / 2, deco), p(-hw + 0.04 + sw, yc - h / 2, deco),
      p(-hw + 0.04 + sw, yc + h / 2, deco), p(-hw + 0.04, yc + h / 2, deco),
      { layer: LAYER.IRON, island: IRON_ISLANDS.hingeStrap, color: TINT.iron }
    )
  }
  strap(y0 + height * 0.78)
  strap(y0 + height * 0.24)
  const rs = 0.17
  b.quad(
    p(hw - 0.26, y0 + 0.95, deco), p(hw - 0.26 + rs, y0 + 0.95, deco),
    p(hw - 0.26 + rs, y0 + 0.95 + rs, deco), p(hw - 0.26, y0 + 0.95 + rs, deco),
    { layer: LAYER.IRON, island: IRON_ISLANDS.ringHandle, color: TINT.iron }
  )

  if (runes) {
    const ly = y0 + height + jw + 0.005
    b.quad(
      p(-(hw + jw), ly, out * 0.5), p(hw + jw, ly, out * 0.5),
      p(hw + jw, ly + 0.055, out * 0.5), p(-(hw + jw), ly + 0.055, out * 0.5),
      { layer: LAYER.RUNE, island: RUNE_ISLANDS.lintelBand, color: TINT.timber }
    )
  }
}

/**
 * A window as a shallow box standing out of the wall, glass on its outer face.
 *
 * Twelve triangles including shutters. The box is what gives a window depth in
 * silhouette against the sky, which a flat quad on the wall never does, and it
 * costs four triangles more than the flat quad would.
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
    { layer: LAYER.GLASS, vWorldY: true, color: TINT.glass }
  )
  if (detail < 2) return

  // The surround, as four thin boxes around the glass. Emitting it as a ring
  // rather than a solid box is what lets the glass sit inside it.
  const ow = hw + frame
  const sides = [
    [-ow, -frame, ow, 0], // sill
    [-ow, height, ow, height + frame], // head
    [-ow, 0, -hw, height], // left
    [hw, 0, ow, height], // right
  ]
  for (const [a0, v0, a1, v1] of sides) {
    const c0 = p(a0, y0 + v0, 0)
    const c1 = p(a1, y0 + v1, depth + 0.02)
    b.box(
      [Math.min(c0[0], c1[0]) - 0.001, y0 + v0, Math.min(c0[2], c1[2]) - 0.001],
      [Math.max(c0[0], c1[0]) + 0.001, y0 + v1, Math.max(c0[2], c1[2]) + 0.001],
      { layer: LAYER.TIMBER_PLANK, color: TINT.timberDark }
    )
  }

  if (shutters) {
    const sd = depth + 0.03
    for (const s of [-1, 1]) {
      const a0 = s < 0 ? -ow - width * 0.52 : ow
      b.quad(
        p(a0, y0, sd), p(a0 + width * 0.52, y0, sd),
        p(a0 + width * 0.52, y0 + height, sd), p(a0, y0 + height, sd),
        { layer: LAYER.TIMBER_PLANK, vWorldY: true, color: TINT.timberDark }
      )
      b.quad(
        p(a0 + 0.02, y0 + height * 0.62, sd + 0.006), p(a0 + width * 0.5, y0 + height * 0.62, sd + 0.006),
        p(a0 + width * 0.5, y0 + height * 0.62 + 0.1, sd + 0.006), p(a0 + 0.02, y0 + height * 0.62 + 0.1, sd + 0.006),
        { layer: LAYER.IRON, island: IRON_ISLANDS.shutterStrap, color: TINT.iron }
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
    { layer: LAYER.STONE, color: grime, skip: ['-y', '+y'] }
  )
  if (detail < 2) {
    b.quad(
      [x - w / 2, topY, z + d / 2], [x + w / 2, topY, z + d / 2],
      [x + w / 2, topY, z - d / 2], [x - w / 2, topY, z - d / 2],
      { layer: LAYER.STONE, color: TINT.stone }
    )
    return
  }
  // A corbelled cap: the courses step out at the top, which is both how a
  // chimney is actually built and what stops it reading as a plain post.
  const o = 0.09
  b.box(
    [x - w / 2 - o, topY - 0.16, z - d / 2 - o],
    [x + w / 2 + o, topY, z + d / 2 + o],
    { layer: LAYER.STONE, color: TINT.stone, skip: ['-y'] }
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
export function porch(b, { x, z, floorY, width = 2.0, depth = 1.3, headY, detail = 2 }) {
  const hw = width / 2
  const z1 = z + depth
  // Deck.
  b.quad(
    [x - hw, floorY, z1], [x + hw, floorY, z1],
    [x + hw, floorY, z], [x - hw, floorY, z],
    { layer: LAYER.TIMBER_PLANK, color: TINT.timber }
  )
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
      { layer: LAYER.STONE, color: groundGrime(groundY, 0.8, 0.3), skip: ['-y', '-z'] }
    )
  }
}
