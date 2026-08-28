import THREE from '../three-instance.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { mulberry32 } from '../sim/mathx.js'

// ---------------------------------------------------------------------------
// Procedural prop geometry. Conifers, boulders, grass clumps, cabins.
//
// All of it is built here rather than authored in Blender because the asset
// pipeline (build step 4) does not exist yet and these are placeholders for
// judging SCALE, not final art. Meshy-generated props replace them at step 5.
//
// Every function here must return a geometry with exactly `position`, `normal`
// and `color`, indexed. That is not a style preference: they all go into one
// BatchedMesh, which validates that every geometry it accepts has an identical
// attribute layout, and one stray `uv` makes the whole batch refuse the mesh.
// ---------------------------------------------------------------------------

// Vertex colours, since there are no textures yet (§7 lands at build step 6).
// Blends between two colours by normalised height within the part, which gives
// each piece some internal shading for free.
export function paint(geo, lo, hi, bias = 0) {
  const pos = geo.attributes.position
  const colors = new Float32Array(pos.count * 3)
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i)
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const span = Math.max(1e-4, maxY - minY)
  const c = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, ((pos.getY(i) - minY) / span) * 0.7 + bias * 0.3)
    c.copy(lo).lerp(hi, t)
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.deleteAttribute('uv')
  return geo
}

export function assemble(parts, lean = 0) {
  const geo = mergeGeometries(parts, false)
  if (!geo) throw new Error('prop merge failed -- part geometries have mismatched attributes')
  for (const p of parts) p.dispose()
  if (lean !== 0) geo.rotateZ(lean)
  geo.computeBoundingSphere()
  return geo
}

// Colours are LINEAR (see the note in sim/chunk-mesh.js). Props sit against the
// terrain palette, so they are in the same dark range -- a prop mixed at sRGB
// values reads as a glowing plastic toy next to linear-0.05 ground.
const TRUNK = new THREE.Color(0.036, 0.024, 0.015)
const NEEDLE_DARK = new THREE.Color(0.012, 0.026, 0.014)
const NEEDLE_LIGHT = new THREE.Color(0.03, 0.058, 0.028)
const STONE_DARK = new THREE.Color(0.03, 0.03, 0.032)
const STONE_LIGHT = new THREE.Color(0.078, 0.076, 0.072)
const BLADE_BASE = new THREE.Color(0.022, 0.034, 0.012)
const BLADE_TIP = new THREE.Color(0.062, 0.082, 0.03)
const TIMBER = new THREE.Color(0.048, 0.032, 0.019)
const TIMBER_LIGHT = new THREE.Color(0.072, 0.05, 0.03)
const THATCH = new THREE.Color(0.055, 0.042, 0.022)
const PLINTH = new THREE.Color(0.04, 0.039, 0.037)

// --- conifer ----------------------------------------------------------------
// An open trunk cylinder plus stacked cones, tapering upward. Radial segments
// are deliberately low -- §1's N64-era brief, and the silhouette is the only
// part that reads at the distances these are seen from.

export function buildConifer({ height, radius, tiers, segments, lean }) {
  const parts = []

  const trunkH = height * 0.34
  const trunk = new THREE.CylinderGeometry(radius * 0.11, radius * 0.17, trunkH, segments, 1, true)
  trunk.translate(0, trunkH / 2, 0)
  paint(trunk, TRUNK, TRUNK)
  parts.push(trunk)

  // Cones overlap by a third of their height so the tiers read as one canopy
  // rather than as separate hats.
  const canopyBase = height * 0.22
  const canopyH = height - canopyBase
  const tierH = canopyH / (1 + (tiers - 1) * 0.62)
  for (let t = 0; t < tiers; t++) {
    const f = t / Math.max(1, tiers - 1)
    const r = radius * (1 - 0.42 * f)
    const cone = new THREE.ConeGeometry(r, tierH * (1 + 0.15 * (1 - f)), segments)
    cone.translate(0, canopyBase + t * tierH * 0.62 + tierH / 2, 0)
    paint(cone, NEEDLE_DARK, NEEDLE_LIGHT, f) // lighter toward the top
    parts.push(cone)
  }

  return assemble(parts, lean)
}

// --- boulder ----------------------------------------------------------------
// A jittered icosahedron. PolyhedronGeometry comes out non-indexed with each
// face's vertices separate, which is exactly what a faceted rock wants -- but
// it means a shared corner appears three times, so the jitter has to be a pure
// function of the ORIGINAL position or the faces come apart at the seams.

export function buildBoulder({ height, squash, jitter, seed }) {
  // Two factors stand between the constructor's radius and the height you get,
  // and a "1 m" boulder that measures 0.63 m is exactly the error a scale
  // reference cannot afford. One is `squash`. The other is that an icosahedron
  // is not as tall as its circumsphere: three's puts vertices at (0, ±1, ±t)
  // normalised, so the Y extent is only t/sqrt(1+t^2) = 0.8507 of the radius,
  // and the full height is 1.7013 r. Divide both out.
  const geo = new THREE.IcosahedronGeometry(height / (1.7013 * squash), 0)
  const pos = geo.attributes.position
  const rand = mulberry32(seed)

  // Pre-draw one offset per distinct corner, keyed by the rounded position.
  const offsets = new Map()
  const key = (x, y, z) => `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`
  for (let i = 0; i < pos.count; i++) {
    const k = key(pos.getX(i), pos.getY(i), pos.getZ(i))
    if (!offsets.has(k)) {
      offsets.set(k, [
        (rand() - 0.5) * jitter,
        (rand() - 0.5) * jitter,
        (rand() - 0.5) * jitter,
      ])
    }
  }

  for (let i = 0; i < pos.count; i++) {
    const o = offsets.get(key(pos.getX(i), pos.getY(i), pos.getZ(i)))
    pos.setXYZ(i, (pos.getX(i) + o[0]) * 1.15, (pos.getY(i) + o[1]) * squash, (pos.getZ(i) + o[2]) * 1.15)
  }

  // Sit the widest part at ground level rather than the centroid, so a boulder
  // reads as half-buried instead of balanced on a point.
  let minY = Infinity
  for (let i = 0; i < pos.count; i++) minY = Math.min(minY, pos.getY(i))
  geo.translate(0, -minY * 0.62, 0)

  geo.computeVertexNormals() // non-indexed, so this gives flat per-face normals
  paint(geo, STONE_DARK, STONE_LIGHT)

  // BatchedMesh needs every geometry indexed. Nothing to weld -- the point is
  // the hard facets -- so this is just an identity index.
  const idx = new Uint16Array(pos.count)
  for (let i = 0; i < idx.length; i++) idx[i] = i
  geo.setIndex(new THREE.BufferAttribute(idx, 1))
  geo.computeBoundingSphere()
  return geo
}

// --- grass clump ------------------------------------------------------------
// Blades are single triangles, each one duplicated with reversed winding and a
// flipped normal. Mirroring in the geometry rather than setting the material to
// DoubleSide keeps backface culling on for every other prop that shares it.
//
// There is no alpha cutout here because there is no texture atlas yet, so a
// blade is a literal tapered triangle. It reads fine at ankle height, which is
// the only place it is ever seen.

export function buildGrass({ blades, height, width, spread, seed }) {
  const rand = mulberry32(seed)
  const tris = blades * 2
  const positions = new Float32Array(tris * 3 * 3)
  const normals = new Float32Array(tris * 3 * 3)
  const colors = new Float32Array(tris * 3 * 3)
  const index = new Uint16Array(tris * 3)

  let v = 0
  const push = (x, y, z, nx, ny, nz, c) => {
    positions[v * 3] = x
    positions[v * 3 + 1] = y
    positions[v * 3 + 2] = z
    normals[v * 3] = nx
    normals[v * 3 + 1] = ny
    normals[v * 3 + 2] = nz
    colors[v * 3] = c.r
    colors[v * 3 + 1] = c.g
    colors[v * 3 + 2] = c.b
    index[v] = v
    v++
  }

  for (let b = 0; b < blades; b++) {
    const ang = rand() * Math.PI * 2
    const dist = Math.sqrt(rand()) * spread
    const bx = Math.cos(ang) * dist
    const bz = Math.sin(ang) * dist
    const h = height * (0.6 + rand() * 0.7)
    const w = width * (0.7 + rand() * 0.6)

    // Blade plane, and the lean of the tip within it.
    const face = rand() * Math.PI
    const ax = Math.cos(face) * w * 0.5
    const az = Math.sin(face) * w * 0.5
    const leanA = rand() * Math.PI * 2
    const lean = h * 0.3 * rand()
    const tx = bx + Math.cos(leanA) * lean
    const tz = bz + Math.sin(leanA) * lean

    // Face normal of the triangle, and its opposite for the mirrored copy.
    const nx = Math.sin(face)
    const nz = -Math.cos(face)

    push(bx - ax, 0, bz - az, nx, 0.35, nz, BLADE_BASE)
    push(bx + ax, 0, bz + az, nx, 0.35, nz, BLADE_BASE)
    push(tx, h, tz, nx, 0.35, nz, BLADE_TIP)

    push(bx + ax, 0, bz + az, -nx, 0.35, -nz, BLADE_BASE)
    push(bx - ax, 0, bz - az, -nx, 0.35, -nz, BLADE_BASE)
    push(tx, h, tz, -nx, 0.35, -nz, BLADE_TIP)
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.setIndex(new THREE.BufferAttribute(index, 1))
  geo.computeBoundingSphere()
  return geo
}

// --- cabin ------------------------------------------------------------------
// A stone plinth, timber walls, and a steep gable roof built from two slabs.
// Steep because that is what a roof under snow load looks like, and it is the
// single detail that makes a box read as Nordic rather than as a shed.
//
// Cabins are the most valuable scale reference in the world: everyone already
// knows how big a door is.

// The two triangles that close the ends of a gable roof, sitting on y = 0 with
// the ridge at y = ridgeH. Wound so each faces outward along its own Z.
function gableEnds(width, ridgeH, depth) {
  const hw = width / 2
  const hd = depth / 2
  const positions = new Float32Array([
    -hw, 0, hd, hw, 0, hd, 0, ridgeH, hd, // front, facing +Z
    hw, 0, -hd, -hw, 0, -hd, 0, ridgeH, -hd, // back, facing -Z
  ])
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, -1, 0, 0, -1])
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geo.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 3, 4, 5]), 1))
  return geo
}

export function buildCabin({ width, depth, wallH, roofPitch, seed }) {
  const rand = mulberry32(seed)
  const parts = []

  const plinth = new THREE.BoxGeometry(width * 1.06, 0.45, depth * 1.06)
  plinth.translate(0, 0.225, 0)
  paint(plinth, PLINTH, PLINTH)
  parts.push(plinth)

  const walls = new THREE.BoxGeometry(width, wallH, depth)
  walls.translate(0, 0.45 + wallH / 2, 0)
  paint(walls, TIMBER, TIMBER_LIGHT)
  parts.push(walls)

  // Gable ends. These have to be actual triangles: a box tall enough to fill
  // the gable is necessarily wider than the roof above 30% of the ridge height,
  // so it pokes straight through the slabs.
  const ridgeH = (width / 2) * roofPitch
  const gable = gableEnds(width, ridgeH, depth)
  gable.translate(0, 0.45 + wallH, 0)
  paint(gable, TIMBER, TIMBER_LIGHT)
  parts.push(gable)

  // One slab per side, running from the ridge down to the eave. rotateZ turns
  // +X toward +Y, so the side at +X needs a NEGATIVE angle to slope downward.
  const angle = Math.atan2(ridgeH, width / 2)
  const slope = Math.hypot(width / 2, ridgeH)
  const eave = 0.35
  for (const side of [-1, 1]) {
    const slab = new THREE.BoxGeometry(slope + eave, 0.22, depth + eave * 2)
    slab.rotateZ(-side * angle)
    slab.translate((side * width) / 4, 0.45 + wallH + ridgeH / 2, 0)
    paint(slab, THATCH, THATCH)
    parts.push(slab)
  }

  // A door, purely so the eye has something of known size to measure against.
  const door = new THREE.BoxGeometry(0.9, 1.95, 0.14)
  door.translate((rand() - 0.5) * width * 0.3, 0.45 + 0.975, depth / 2 + 0.02)
  paint(door, TRUNK, TRUNK)
  parts.push(door)

  return assemble(parts)
}
