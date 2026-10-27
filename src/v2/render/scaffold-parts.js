// What render/palisades.js draws and walks of a scaffold labyrinth's tower (layers/scaffold.js; design/41-palisade-labyrinths.md, "The scaffold tower"): its plank bays and ladders as fixtures, its nets as one alpha-masked mesh, and its spans and ladders for the walker and the hands. All read the ground through the `ground(x, z)` they are handed.
import THREE from '../../three-instance.js'
import { POST } from '../../props/palisade.js'
import { LAYER } from '../../textures.js'
import { mulberry32 } from '../../sim/mathx.js'
import { PLANK, SCAFFOLD, SIDES, bayPoint, frameOf, inHatch, ladderSpots, levelY, postsAt, sidePoint } from '../layers/scaffold.js'

const N = SCAFFOLD.bays
const B = SCAFFOLD.bay
// The ladder's rails stand this far over the floor they serve, the handhold for stepping off (render/palisades.js LADDER_OVER).
export const OVER = 1
// Metres either side of a net wall's line that stop her, and a plank's thickness, and a net floor's.
export const WALL_R = 0.12
export const PLANK_THICK = 0.18
export const NET_THICK = 0.04
// World metres one net texture tile covers.
const NET_TILE = 1
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
const _f = [0, 0, 0, 0]
const _pt = [0, 0]

// The world unit of side d of a bay, in the scaffold's frame u, v.
const sideWorld = (sc, d) => [SIDES[d][0] * sc.ux + SIDES[d][1] * sc.vx, SIDES[d][0] * sc.uz + SIDES[d][1] * sc.vz]

/** A bay's plank deck `half` square with a hatch cut at its +x edge, its top on y = 0, in the post's attributes (props/palisade.js): `hatch` = [near, far] metres in from that edge, `hatchHalf` either side of its middle. */
export function buildHatchDeck(half, hatch, hatchHalf, seed = 1) {
  const rand = mulberry32(seed * 104729 + 11)
  const thick = 0.06
  const slab = (x0, x1, z0, z1) => [new THREE.BoxGeometry(x1 - x0 - 0.012, thick, z1 - z0 - 0.012), [(x0 + x1) / 2, -thick / 2, (z0 + z1) / 2], LAYER.TIMBER_HEWN, 0.75 + 0.25 * rand()]
  const x1 = half - hatch[1], x2 = half - hatch[0]
  const parts = [slab(-half, x1, -half, half), slab(x1, x2, hatchHalf, half), slab(x1, x2, -half, -hatchHalf), slab(x2, half, -half, half), [new THREE.BoxGeometry(0.1, 0.12, 2 * half), [-half * 0.55, -thick - 0.06, 0], LAYER.TIMBER_BEAM, 0.7]]
  const pos = [], nrm = [], uv = [], layer = [], col = []
  for (const [g0, [ox, oy, oz], l, shade] of parts) {
    const g = g0.toNonIndexed()
    g.translate(ox, oy, oz)
    const p = g.getAttribute('position'), n = g.getAttribute('normal')
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i)
      const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i))
      pos.push(x, y, z)
      nrm.push(n.getX(i), n.getY(i), n.getZ(i))
      if (ay >= ax && ay >= az) uv.push(x / POST.texMetres, z / POST.texMetres)
      else if (ax >= az) uv.push(z / POST.texMetres, y / POST.texMetres)
      else uv.push(x / POST.texMetres, y / POST.texMetres)
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

/** The scaffold's ladders as records for Palisades.ladderAt and rungAt: `x, z` her climbing spot, `ux, uz` the unit out of the ladder's face (toward her), `px, pz` its plane's middle, `exitX, exitZ` where the top steps her off, `bottom` and `top` the floors it joins, `ground` whether its foot is on the ground. */
export function scaffoldLadders(sc, ground) {
  return sc.ladders.map((ld) => {
    const sp = (ld.spots ??= ladderSpots(sc, ld))
    return {
      x: sp.foot[0], z: sp.foot[1], ux: -sp.face[0], uz: -sp.face[1], px: sp.plane[0], pz: sp.plane[1], exitX: sp.exit[0], exitZ: sp.exit[1],
      bottom: ld.l === 0 ? ground(sp.foot[0], sp.foot[1]) : levelY(sc, ground, ld.l), top: levelY(sc, ground, ld.l + 1), ground: ld.l === 0,
    }
  })
}

/** The height the scaffold's posts stand to: the rails' tops on the plank ladder. */
export const postTop = (sc, ground) => levelY(sc, ground, PLANK) + OVER

/** Whether (x, y, z) is on the plank: over its square, her feet no more than a stride under its top. */
export function onPlank(sc, ground, x, y, z) {
  frameOf(sc, x, z, _f)
  return Math.abs(_f[0]) <= (N * B) / 2 && Math.abs(_f[1]) <= (N * B) / 2 && y >= levelY(sc, ground, PLANK) - 0.3
}

/** Stone spans of the scaffold on (x, z), each handed to `put(bottom, top, sheer)`; `g` is the ground there and `postR` the posts' collision radius. The posts and net walls are sheer, the floors and plank are not, and a ladder's hatch is no floor. */
export function scaffoldSpans(sc, ground, x, z, g, postR, put) {
  frameOf(sc, x, z, _f)
  const a = _f[0], b = _f[1], half = (N * B) / 2
  const plank = levelY(sc, ground, PLANK)
  for (const [px, pz] of (sc._posts ??= postsAt(sc))) if ((x - px) ** 2 + (z - pz) ** 2 < postR * postR) put(g - POST.bury, plank + OVER, true)
  if (Math.abs(a) > half + WALL_R || Math.abs(b) > half + WALL_R) return
  const i = Math.min(N - 1, Math.max(0, Math.floor(a / B + N / 2))), j = Math.min(N - 1, Math.max(0, Math.floor(b / B + N / 2)))
  const inside = Math.abs(a) <= half && Math.abs(b) <= half
  const p = Math.round(a / B + N / 2), q = Math.round(b / B + N / 2)
  const onI = Math.abs(a - (p - N / 2) * B) < WALL_R, onJ = Math.abs(b - (q - N / 2) * B) < WALL_R
  for (let l = 1; l <= SCAFFOLD.floors; l++) {
    const y = levelY(sc, ground, l)
    if (inside && sc.floor[l][i * N + j] && !inHatch(sc, l, i, j, a, b)) put(y - NET_THICK, y, false)
    if ((onI && sc.walls[l][p * N + j]) || (onJ && sc.walls[l][(N + 1) * N + q * N + i])) put(y - 0.02, y + SCAFFOLD.wall, true)
  }
  if (inside && !inHatch(sc, PLANK, i, j, a, b)) put(plank - PLANK_THICK, plank, false)
}

/** The rope's places: `coil` [x, z] on the plank, `hang` [x, z] out past the plank's edge where it falls, `top` the plank's height, `bottom` the ground at `hang`. */
export function scaffoldRope(sc, ground) {
  const { i, j, d } = sc.rope
  const coil = sidePoint(sc, i, j, d, SCAFFOLD.ropeIn, [0, 0]), hang = sidePoint(sc, i, j, d, -SCAFFOLD.ropeOut, [0, 0])
  return { coil, hang, top: levelY(sc, ground, PLANK), bottom: ground(hang[0], hang[1]) }
}

/** Maze scaffold `sc`'s fixtures standing on `ground`, each handed to `put(kind, matrix)`: a plank deck per bay (the hatch bays' cut), each ladder, and the rope's coil or, once dropped (`ropeDown`), its hanging length. */
export function poseScaffold(sc, ground, put, ropeDown) {
  const plank = levelY(sc, ground, PLANK)
  const yawOf = (dx, dz) => _q.setFromAxisAngle(_up, Math.atan2(-dz, dx))
  const hatches = new Map(sc.ladders.filter((ld) => ld.l === SCAFFOLD.floors).map((ld) => [ld.i * N + ld.j, ld]))
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      bayPoint(sc, i, j, 0, 0, _pt)
      const ld = hatches.get(i * N + j)
      if (ld === undefined) put('scaffoldDecks', _m.compose(_p.set(_pt[0], plank, _pt[1]), yawOf(sc.ux, sc.uz), _s.set(1, 1, 1)))
      else {
        const [dx, dz] = sideWorld(sc, ld.d)
        put('hatchDecks', _m.compose(_p.set(_pt[0], plank, _pt[1]), yawOf(dx, dz), _s.set(1, 1, 1)))
      }
    }
  }
  for (const l of scaffoldLadders(sc, ground)) {
    _q.setFromAxisAngle(_up, Math.atan2(-l.uz, l.ux) + Math.PI / 2)
    put('rungs', _m.compose(_p.set(l.px, l.bottom, l.pz), _q, _s.set(1, (l.top + OVER - l.bottom) / (SCAFFOLD.rise + OVER), 1)))
  }
  const r = scaffoldRope(sc, ground)
  if (!ropeDown) put('coils', _m.makeTranslation(r.coil[0], plank, r.coil[1]))
  else put('ropes', _m.compose(_p.set(r.hang[0], r.bottom, r.hang[1]), _q.identity(), _s.set(1, r.top + 0.15 - r.bottom, 1)))
}

/** One geometry of every net in `scaffolds` (their `sc`s) standing on `ground`: floors a bay at a time with the hatches' holes left out, and each wall; `{ geometry, count }` with `count` the quads, or count 0 and no geometry. */
export function netGeometry(scaffolds, ground) {
  const pos = [], nrm = [], uv = []
  const quad = (c, n, uvs) => {
    for (const k of [0, 1, 2, 0, 2, 3]) {
      pos.push(c[k][0], c[k][1], c[k][2])
      nrm.push(n[0], n[1], n[2])
      uv.push(uvs[k][0], uvs[k][1])
    }
  }
  for (const sc of scaffolds) {
    const around = (x, z) => [((x - sc.cx) * sc.ux + (z - sc.cz) * sc.uz) / NET_TILE, ((x - sc.cx) * sc.vx + (z - sc.cz) * sc.vz) / NET_TILE]
    for (let l = 1; l <= SCAFFOLD.floors; l++) {
      const y = levelY(sc, ground, l), F = sc.floor[l], W = sc.walls[l]
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          if (!F[i * N + j]) continue
          const hatch = sc.ladders.find((ld) => ld.l + 1 === l && ld.i === i && ld.j === j)
          let rects
          const h = B / 2
          if (hatch === undefined) rects = [[-h, h, -h, h]]
          else {
            const x1 = h - SCAFFOLD.hatch[1], x2 = h - SCAFFOLD.hatch[0], c = SCAFFOLD.hatchHalf
            rects = [[-h, x1, -h, h], [x1, x2, c, h], [x1, x2, -h, -c], [x2, h, -h, h]]
          }
          const [ex, ez] = hatch === undefined ? [sc.ux, sc.uz] : sideWorld(sc, hatch.d)
          bayPoint(sc, i, j, 0, 0, _pt)
          const cx = _pt[0], cz = _pt[1]
          for (const [p0, p1, q0, q1] of rects) {
            const at = (p, q) => [cx + ex * p - ez * q, y, cz + ez * p + ex * q]
            const cs = [at(p0, q0), at(p1, q0), at(p1, q1), at(p0, q1)]
            quad(cs, [0, 1, 0], cs.map((c) => around(c[0], c[2])))
          }
        }
      }
      // Each wall, from the lattice line's end to its other: the i-edges run along v, the j-edges along u.
      for (let e = 0; e < W.length; e++) {
        if (!W[e]) continue
        const along = e < (N + 1) * N
        const k = along ? Math.floor(e / N) : Math.floor((e - (N + 1) * N) / N), t = along ? e % N : (e - (N + 1) * N) % N
        const lo = (t - N / 2) * B, line = (k - N / 2) * B
        const [x0, z0] = along ? [sc.cx + sc.ux * line + sc.vx * lo, sc.cz + sc.uz * line + sc.vz * lo] : [sc.cx + sc.ux * lo + sc.vx * line, sc.cz + sc.uz * lo + sc.vz * line]
        const [dx, dz] = along ? [sc.vx * B, sc.vz * B] : [sc.ux * B, sc.uz * B]
        const top = y + SCAFFOLD.wall, run = B / NET_TILE, rise = SCAFFOLD.wall / NET_TILE
        const nx = -dz / B, nz = dx / B
        quad([[x0, y, z0], [x0 + dx, y, z0 + dz], [x0 + dx, top, z0 + dz], [x0, top, z0]], [nx, 0, nz], [[0, 0], [run, 0], [run, rise], [0, rise]])
      }
    }
  }
  if (pos.length === 0) return { geometry: null, count: 0 }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  geometry.computeBoundingSphere()
  return { geometry, count: pos.length / 18 }
}
