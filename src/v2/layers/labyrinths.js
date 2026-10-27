// Palisade labyrinths (DESIGN.md §41): round mazes in the wood, walled by curved runs of sharpened posts.
//
// Three-free and pure: a labyrinth is a function of the world seed, its region cell and the ground, generated on first
// ask and memoized. Its walls are polylines sampled off a warped polar maze; render/palisades.js stands posts along them
// near the eye and is the walker's stone along the same lines whether or not the posts are placed.
//
// THE WORLD PLAN SITES THEM (layers.labyrinthSites): every holder (main thread, terrain worker) reads the same footprints,
// or the wood and the walls part company. Without one, each sites off the ground as first asked.

import { mulberry32, smoothstep } from '../../sim/mathx.js'
import { WORLD_HALF } from '../config.js'
import { PLANK, SCAFFOLD, bayPoint, ladderSpots, levelY, placeOf, postsAt, routeOf, scaffoldOf } from './scaffold.js'

export const LABYRINTH = {
  // Metres per region cell; a cell holds one labyrinth at odds `chance`.
  region: 620,
  chance: 0.9,
  // The outer wall's radius before the warp, rolled per labyrinth, and the metres between ring walls.
  radius: [16.2, 25.5],
  pitch: 2.325,
  // The open middle's radius (a tower labyrinth's is SCAFFOLD.centre), and the odds a labyrinth has the tower.
  centre: 2.25,
  tower: 0.5,
  // A ring's cells split in two where they would be wider than this along their inner wall.
  split: 2.54,
  // Interior walls knocked out after the carve, per cell: a few loops, so a wrong turn is not always a dead end.
  loops: 0.04,
  // The warp: radians the rings twist through, and the outline's three- and five-lobed swell as shares of the radius.
  twist: 0.11,
  lobe3: 0.07,
  lobe5: 0.035,
  // Metres of full forest the biome holds past the outline, then the metres it eases back to the field's own cover over.
  wood: 10,
  fray: 25,
  // Positions tried per region for one whose disc is all gentle, dry, road-free ground.
  tries: 48,
  maxSlopeDeg: 24,
  // Metres clear of trees, dead wood, rocks and creatures past the outline, and round the entrance's mouth.
  keep: 1.5,
  mouth: 3,
  // Metres between the posts either side of the one way in, which the torches flank.
  gate: 2.1,
}

// The post: render/palisades.js asserts POST_R against props/palisade.js POST.radius, and POST_FACE is its mean silhouette radius as a share of that (POST.rough jitters inward up to 7%).
export const POST_R = 0.15
export const POST_FACE = 0.965
// Each post a different tree: its girth (radius scale) rolled off POST_GIRTH, then the line's girths scaled together so its posts end on its ends. Neighbours stand their two radii apart plus a crack: open (daylight) at odds `open`, else snug.
export const POST_GIRTH = [0.7, 1.45]
export const CRACK = { open: 0.4, width: [0.008, 0.04], snug: 0.015 }
// Floats per post in postsOf: x, z, the wall's unit tangent there, yaw, roll, girth, height. Height is 1 for a wall post (exactly POST.height, so the maze reads from a lookout and a post's top is the collision's), else a plumb post's share of POST.height.
export const POST_STRIDE = 8
// The watchtowers (DESIGN.md §41), one per `perCells` cells and at least `least`, each in a dead end: four posts `height` tall at the corners of a square `half` from its middle, a plank deck `deckHalf` square with its top at `deck`, and the ladder on the face toward the way in, its rails `ladderHalf` either side and `ladderOut` from the middle. A climber's origin stands `foot` out.
export const TOWER = { perCells: 40, least: 2, half: 0.42, girth: 0.85, height: 8, deck: 7.1, deckHalf: 0.75, ladderOut: 0.62, ladderHalf: 0.25, foot: 0.95 }
// The middle: a stone plinth `half` square and `height` tall carrying the egg, and the beacon (a torch post `height` tall) `behind` it from the door.
export const ALTAR = { half: 0.32, height: 1 }
export const BEACON = { height: 4, behind: 0.9 }

/** The height the maze's altar stands on: the ground there, or a tower labyrinth's plank. */
export const altarY = (m, ground) => (m.scaffold === null ? ground(m.altar.x, m.altar.z) : levelY(m.scaffold, ground, PLANK))

// The labyrinth clock (timeLimit): metres a second she is allowed to walk (75% of player.js LOCOMOTION.maxSpeed) and climb (climb.js CLIMB.speed); check-labyrinth-clock asserts both.
export const CLOCK = { walk: 0.75 * 1.45, climb: 0.9 }
// Metres a radial wall stops short of a ring wall it meets, so its last post stands against the ring's posts, not in them.
const JOIN = 0.28
// Metres between a wall's samples before the warp; chord against arc on the smallest ring is under a centimetre.
const SAMPLE = 0.4
// The wall hash's cell, and how far past a segment it is filed: wallAt's pad plus POST_R must stay under it.
const HASH = 2
const HASH_PAD = 0.6
// The siting samples' spacing over the disc, and rocks.js PLACEMENT_CELL / SHORE_RISE so the siting reads the ground as the beds do.
const SITE_STEP = 5
const SLOPE_CELL = 4.0
const SHORE_RISE = 1.6
const ROAD_CLEAR = 6
const MAX_TAN = Math.tan((LABYRINTH.maxSlopeDeg * Math.PI) / 180)
const TAU = Math.PI * 2
// props/palisade.js POST.height, which render/palisades.js asserts: a tower post's height share is its own over this.
export const POST_HEIGHT = 4
// The clearance round a ladder's foot past a wall's line: the walker's radius and a little.
const FOOT_CLEAR = 0.2
// A tower's corners in its cell's (radial, round) frame before the warp, in units of TOWER.half, in order round the square.
const towerCorners = [[1, 1], [1, -1], [-1, -1], [-1, 1]]
// The torches stand this far outside the outer wall, one at each side of the entrance.
const TORCH_OUT = 0.55
// The middle's node in the walkable graph (mazeOf `ways`), toward the door this share of the middle's radius: clear of the altar, and of a tower's square.
const MIDDLE_NODE = 0.6
const SCAFFOLD_NODE = 0.8
// entranceOf: metres past the torches' line along the way out.
const ENTRANCE_OUT = 1

function regionHash(rx, rz, seed) {
  let h = Math.imul(rx | 0, 0x2c1b3c6d) ^ Math.imul(rz | 0, 0x297a2d39) ^ Math.imul(seed | 0, 0x68e31da4) ^ 0x50414c49
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

// The outline's swell at warped bearing `a`: the outer wall stands at rOuter * (1 + swell).
const swell = (s, a) => LABYRINTH.lobe3 * Math.sin(3 * a + s.p3) + LABYRINTH.lobe5 * Math.sin(5 * a + s.p5)
const SWELL_MAX = LABYRINTH.lobe3 + LABYRINTH.lobe5
// pathOf's scratch, and aimOf's.
let _parent = new Int32Array(0)
const _queue = [], _path = [], _pts = []
// aimOf: how many of the way's next points it looks ahead over, and how far its straight line keeps off a wall (the graph's legs keep 0.25 m).
const AIM_AHEAD = 5, AIM_PAD = 0.25
const put = (out, x, z) => { out[0] = x; out[1] = z; return out }

/** Whether (x, z) is within `r` of any of `segments`, through their `hash`. */
function hashedWallAt(h, seg, x, z, r) {
  const i = Math.floor((x - h.x0) / HASH), j = Math.floor((z - h.z0) / HASH)
  if (i < 0 || j < 0 || i >= h.n || j >= h.n) return false
  const list = h.cells[j * h.n + i]
  if (list === null) return false
  for (let q = 0; q < list.length; q++) {
    const k = list[q] * 4
    const ax = seg[k], az = seg[k + 1], dx = seg[k + 2] - ax, dz = seg[k + 3] - az
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)))
    if ((x - ax - t * dx) ** 2 + (z - az - t * dz) ** 2 < r * r) return true
  }
  return false
}

/** Each ring's cell count: at least 6 in ring 0, doubling where a cell would be wider than `split` along its inner wall. */
function sectorsOf(rings, C) {
  const P = LABYRINTH.pitch
  const sectors = [Math.max(6, Math.round((TAU * (C + P / 2)) / (1.6 * P)))]
  for (let k = 1; k < rings; k++) {
    const prev = sectors[k - 1]
    sectors.push((TAU * (C + k * P)) / (2 * prev) >= LABYRINTH.split ? prev * 2 : prev)
  }
  return sectors
}

// Carrots at every dead end (carrotsOf): 1 to CARROTS.most a dead end, `back` metres from the cell's middle away from its way out and `spread` either side; under a tower, `under` either side of its posts' middle, since the rings' twist shears its square. DEAD_ENDS_MAX is the share of the largest labyrinth's cells render/carrots.js budgets dead ends for; check-labyrinths holds every one under it.
export const CARROTS = { most: 3, back: 0.4, spread: 0.15, under: 0.1 }
export const DEAD_ENDS_MAX = Math.ceil(0.2 * sectorsOf(Math.round((LABYRINTH.radius[1] - LABYRINTH.centre) / LABYRINTH.pitch), LABYRINTH.centre).reduce((a, b) => a + b, 0))

/** Polar (r, a) before the warp to world xz into `out`. Bijective: the twist turns each radius rigidly and the swell scales each bearing's ray, so walls never cross. */
export function warp(s, r, a, out) {
  const aw = a + LABYRINTH.twist * Math.sin((1.4 * Math.PI * r) / s.rOuter + s.phase)
  const rw = r * (1 + swell(s, aw))
  out[0] = s.cx + rw * Math.cos(aw)
  out[1] = s.cz + rw * Math.sin(aw)
  return out
}

const TYPICAL = 0x7fff

/** A labyrinth's middle radius, rings, outer wall radius and reach (to its torches and past) off its rolled radius `R`; `tower` is whether SCAFFOLD stands in its middle. */
function ringsOf(R, tower) {
  const centre = tower ? SCAFFOLD.centre : LABYRINTH.centre
  const rings = Math.max(3, Math.round((R - centre) / LABYRINTH.pitch))
  const rOuter = centre + rings * LABYRINTH.pitch
  return { tower, centre, rings, rOuter, reach: rOuter * (1 + SWELL_MAX) + TORCH_OUT + 0.5 }
}

let live = null
const need = () => {
  if (live === null) throw new Error('labyrinths: no Labyrinths has been built')
  return live
}
/** The footprint of the labyrinth she stands in (inside its outer wall's line), or null; read off the most recently built Labyrinths. */
export const labyrinthAt = (x, z) => need().labyrinthAt(x, z)
/** `{ x, y, z, heading }` just outside `site`'s gate and facing in; heading is the creatures' convention (forward (cos, -sin)). */
export const entranceOf = (site) => need().entranceOf(site)
/** Seconds she has to walk `site`'s solved route to the prize: the route's walking at CLOCK.walk plus the ladders she climbs up at CLOCK.climb. */
export const timeLimit = (site) => need().timeLimit(site)

export class Labyrinths {
  /** `ground` is the world's V2Height; its `scatterAt` and `layers` are read. */
  constructor({ seed, ground }) {
    if (typeof seed !== 'number' || !Number.isFinite(seed)) throw new Error(`Labyrinths: seed must be a finite number, got ${seed}`)
    if (typeof ground?.scatterAt !== 'function') throw new Error('Labyrinths: ground must be the height field (scatterAt), which the labyrinths are sited on')
    this.seed = seed
    this.ground = ground
    this._g = { h: 0, tan: 0 }
    this._sites = new Map()
    this._baked = null
    this._mazes = new Map()
    live = this
  }

  /**
   * Region (rx, rz)'s labyrinth footprint, or null: `{ rx, rz, cx, cz, tower, centre, rings, rOuter, reach, p3, p5, phase, a0 }`. The
   * first of `tries` centres whose disc is in the world and on gentle, dry, road-free ground. No maze is built, so the
   * biome can ask it per vertex. Read off `layers.labyrinthSites` where the world plan has set them (sited before their
   * trails, which would move them), else sited here.
   */
  siteOf(rx, rz) {
    const key = rx * 0x10000 + rz
    const baked = this.ground.layers.labyrinthSites
    if (baked !== null) {
      if (this._baked !== baked) {
        this._baked = baked
        this._sites = new Map(baked.map((b) => [b.rx * 0x10000 + b.rz, b]))
      }
      return this._sites.get(key) ?? null
    }
    let s = this._sites.get(key)
    if (s !== undefined) return s
    const rand = mulberry32(regionHash(rx, rz, this.seed))
    s = null
    if (rand() < LABYRINTH.chance) {
      const tower = (regionHash(rx, rz, this.seed ^ 0x7e0a11e5) >>> 8) / 0x1000000 < LABYRINTH.tower
      const { centre, rings, rOuter, reach } = ringsOf(LABYRINTH.radius[0] + rand() * (LABYRINTH.radius[1] - LABYRINTH.radius[0]), tower)
      const shape = { p3: rand() * TAU, p5: rand() * TAU, phase: rand() * TAU, a0: rand() * TAU }
      const margin = reach + LABYRINTH.wood + LABYRINTH.fray
      const room = LABYRINTH.region - 2 * margin
      for (let t = 0; t < LABYRINTH.tries && s === null; t++) {
        const cx = rx * LABYRINTH.region + margin + rand() * room
        const cz = rz * LABYRINTH.region + margin + rand() * room
        if (this._fits(cx, cz, reach)) s = { rx, rz, cx, cz, tower, centre, rings, rOuter, reach, ...shape }
      }
    }
    this._sites.set(key, s)
    return s
  }

  /** A labyrinth of the middle radius at the origin, under a region key no world reaches: the model render/palisades.js photographs for every labyrinth's far card. */
  typicalSite() {
    return { rx: TYPICAL, rz: TYPICAL, cx: 0, cz: 0, ...ringsOf((LABYRINTH.radius[0] + LABYRINTH.radius[1]) / 2, false), p3: 1, p5: 2, phase: 0.5, a0: 0 }
  }

  /** Whether a disc `reach` across at (cx, cz) is inside the world with its wood, and every sample of it gentle, a shore rise over any water and clear of roads. */
  _fits(cx, cz, reach) {
    const margin = reach + LABYRINTH.wood + LABYRINTH.fray
    if (cx - margin < -WORLD_HALF || cz - margin < -WORLD_HALF || cx + margin > WORLD_HALF || cz + margin > WORLD_HALF) return false
    const { lakes, paths } = this.ground.layers
    for (let r = 0; r <= reach; r += SITE_STEP) {
      const n = Math.max(1, Math.ceil((TAU * r) / SITE_STEP))
      for (let i = 0; i < n; i++) {
        const x = cx + r * Math.cos((i * TAU) / n), z = cz + r * Math.sin((i * TAU) / n)
        const g = this.ground.scatterAt(x, z, SLOPE_CELL, this._g)
        if (g.tan > MAX_TAN) return false
        const lake = lakes.levelAt(x, z), river = paths.riverLevelAt(x, z)
        const level = lake === null ? river : river === null ? lake : Math.max(lake, river)
        if (level !== null && g.h < level + SHORE_RISE) return false
        const road = paths.nearest(x, z, 'road')
        if (road !== null && road.dist < road.halfWidth + ROAD_CLEAR) return false
      }
    }
    return true
  }

  /** The footprint whose region holds (x, z), or null. */
  siteAt(x, z) {
    return this.siteOf(Math.floor(x / LABYRINTH.region), Math.floor(z / LABYRINTH.region))
  }

  /** Every footprint whose reach meets the box. */
  sitesIn(x0, z0, x1, z1, out = []) {
    out.length = 0
    const r0 = Math.floor(x0 / LABYRINTH.region), r1 = Math.floor(x1 / LABYRINTH.region)
    const q0 = Math.floor(z0 / LABYRINTH.region), q1 = Math.floor(z1 / LABYRINTH.region)
    for (let rz = q0; rz <= q1; rz++) {
      for (let rx = r0; rx <= r1; rx++) {
        const s = this.siteOf(rx, rz)
        if (s !== null && s.cx + s.reach > x0 && s.cx - s.reach < x1 && s.cz + s.reach > z0 && s.cz - s.reach < z1) out.push(s)
      }
    }
    return out
  }

  /** How much the labyrinth at (x, z) holds the cover up: 1 over its reach and `wood` past it, easing to 0 over `fray`. */
  woodAt(x, z) {
    const s = this.siteAt(x, z)
    if (s === null) return 0
    const d = Math.hypot(x - s.cx, z - s.cz) - s.reach
    return d <= LABYRINTH.wood ? 1 : smoothstep(LABYRINTH.wood + LABYRINTH.fray, LABYRINTH.wood, d)
  }

  /** Whether a disc `r` across at (x, z) reaches a labyrinth's ground; the region margin keeps a neighbour's out of reach of any rock-sized r. */
  reaches(x, z, r) {
    const s = this.siteAt(x, z)
    return s !== null && Math.hypot(x - s.cx, z - s.cz) < s.reach + r
  }

  /** Whether (x, z) is within `pad` of the inside of the outer wall's line. */
  insideAt(x, z, pad = 0) {
    const s = this.siteAt(x, z)
    if (s === null) return false
    const d = Math.hypot(x - s.cx, z - s.cz)
    if (d > s.reach + pad) return false
    return d < s.rOuter * (1 + swell(s, Math.atan2(z - s.cz, x - s.cx))) + pad
  }

  /** Whether (x, z) is within `reach` of the outline of the labyrinth there: then `out.s` is its site, `out.near` 0 at `reach` outside rising to 1 at the middle's edge, and `out.middle` whether it is in the middle. The region margin keeps a neighbour's past any reach under LABYRINTH.wood + fray. */
  nearness(x, z, reach, out) {
    const s = this.siteAt(x, z)
    if (s === null) return false
    const d = Math.hypot(x - s.cx, z - s.cz)
    const k = 1 + swell(s, Math.atan2(z - s.cz, x - s.cx))
    const far = s.rOuter * k + reach, mid = s.centre * k
    if (d >= far) return false
    out.s = s
    out.near = Math.min(1, (far - d) / (far - mid))
    out.middle = d < mid
    return true
  }

  /** The node of footprint `s`'s walkable graph (mazeOf `ways`) holding (x, z): a cell's id, the middle's, or -1 outside the outer wall's line. The warp undone: the swell is a function of the warped bearing and the twist of the unwarped radius. */
  nodeAt(s, x, z) {
    const m = this.mazeOf(s)
    const aw = Math.atan2(z - s.cz, x - s.cx)
    const r = Math.hypot(x - s.cx, z - s.cz) / (1 + swell(s, aw))
    if (r < s.centre) return m.cells.length
    const k = Math.floor((r - s.centre) / LABYRINTH.pitch)
    if (k >= s.rings) return -1
    const a = aw - LABYRINTH.twist * Math.sin((1.4 * Math.PI * r) / s.rOuter + s.phase)
    const n = m.sectors[k], t = (((a - s.a0) / TAU) * n) % n
    return m.offs[k] + (Math.floor(t + n) % n)
  }

  /** Whether a thing `pad` across at (x, z) is on ground the labyrinth keeps clear: its inside and `keep` past the outline, and the entrance's mouth. */
  keepOutAt(x, z, pad = 0) {
    if (this.insideAt(x, z, pad + LABYRINTH.keep)) return true
    const s = this.siteAt(x, z)
    if (s === null) return false
    const m = this.mazeOf(s).mouth
    return Math.hypot(x - m[0], z - m[1]) < LABYRINTH.mouth + pad
  }

  /** Whether (x, z) is within `pad` of a post's footprint: within POST_R + pad of a wall's line. The walker's wall, placed posts or none. */
  wallAt(x, z, pad = 0) {
    if (pad + POST_R > HASH_PAD) throw new Error(`Labyrinths.wallAt: pad ${pad} reaches past the hash's ${HASH_PAD - POST_R}`)
    const s = this.siteAt(x, z)
    if (s === null || Math.hypot(x - s.cx, z - s.cz) > s.reach) return false
    const m = this.mazeOf(s)
    return hashedWallAt(m.hash, m.segments, x, z, POST_R + pad)
  }

  /** Whether (x, z) is within POST_R of a wall's line, as wallAt: then `out` is the unit normal of the nearest piece of it. */
  wallAcross(x, z, out) {
    const s = this.siteAt(x, z)
    if (s === null || Math.hypot(x - s.cx, z - s.cz) > s.reach) return false
    const m = this.mazeOf(s), h = m.hash
    const i = Math.floor((x - h.x0) / HASH), j = Math.floor((z - h.z0) / HASH)
    if (i < 0 || j < 0 || i >= h.n || j >= h.n || h.cells[j * h.n + i] === null) return false
    const seg = m.segments
    let best = POST_R * POST_R
    for (const q of h.cells[j * h.n + i]) {
      const k = q * 4
      const ax = seg[k], az = seg[k + 1], dx = seg[k + 2] - ax, dz = seg[k + 3] - az
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)))
      const d2 = (x - ax - t * dx) ** 2 + (z - az - t * dz) ** 2
      if (d2 >= best) continue
      best = d2
      const L = Math.hypot(dx, dz)
      out.x = -dz / L
      out.z = dx / L
    }
    return best < POST_R * POST_R
  }

  /**
   * The labyrinth on footprint `s`, memoized:
   *   `sectors[k]`, `wallCw[k][j]` (the radial wall past cell j of ring k), `wallIn[k][j]` (the ring wall on its inner
   *   side; ring 0's against the middle), `wallOut[j]` (the outer wall of the last ring's cell j), 1 where a wall stands;
   *   `entrance` (the last ring's opened cell), `door` (ring 0's cell opened to the middle);
   *   `lines` [{ xz: Float32Array, closed }], `segments` (their pieces, x0 z0 x1 z1), `hash`;
   *   `cells` [x, z] per cell ring by ring, `centre`, `mouth` [x, z] a pace outside the entrance, `torches` [[x, z], [x, z]];
   *   `towers` [{ x, z, ux, uz, corners, cell }] (u the unit out of its ladder's face, `corners` its posts' [x, z]), `altar` { x, z, ux, uz } (u toward the door; a tower labyrinth's on its plank), `beacon` [x, z], `scaffold` (layers/scaffold.js, null in a plain labyrinth), `scaffoldFrom` (the index of postsOf's first scaffold post);
   *   `ways[id]` [{ to, x, z }] each opening out of node id (a cell, or `cells.length` the middle, at [x, z] `middle`) and the point in it, the entrance not among them.
   * Carved as a depth-first backtracker over the cells (long winding corridors), opened in `loops` places, then given one
   * door to the middle and one entrance, the outer cell farthest from that door along the carve.
   */
  mazeOf(s) {
    const key = s.rx * 0x10000 + s.rz
    let m = this._mazes.get(key)
    if (m !== undefined) return m
    const rand = mulberry32(regionHash(s.rx, s.rz, this.seed ^ 0x5bd1e995))
    const { rings } = s
    const P = LABYRINTH.pitch, C = s.centre
    const bound = (k) => C + k * P
    const sectors = sectorsOf(rings, C)
    const offs = [0]
    for (let k = 0; k < rings; k++) offs.push(offs[k] + sectors[k])
    const total = offs[rings]
    const wallCw = sectors.map((n) => new Uint8Array(n).fill(1))
    const wallIn = sectors.map((n) => new Uint8Array(n).fill(1))
    const wallOut = new Uint8Array(sectors[rings - 1]).fill(1)
    const cellOf = (id) => {
      let k = 0
      while (id >= offs[k + 1]) k++
      return [k, id - offs[k]]
    }
    // Each neighbour as [id, open-it]: around the ring, in to the one cell inside, out to the one or two outside.
    const neighbours = (k, j) => {
      const n = sectors[k], out = []
      out.push([offs[k] + ((j + 1) % n), () => { wallCw[k][j] = 0 }])
      out.push([offs[k] + ((j - 1 + n) % n), () => { wallCw[k][(j - 1 + n) % n] = 0 }])
      if (k > 0) out.push([offs[k - 1] + Math.floor((j * sectors[k - 1]) / n), () => { wallIn[k][j] = 0 }])
      if (k + 1 < rings) {
        const f = sectors[k + 1] / n
        for (let q = 0; q < f; q++) out.push([offs[k + 1] + j * f + q, () => { wallIn[k + 1][j * f + q] = 0 }])
      }
      return out
    }
    const seen = new Uint8Array(total)
    const parent = new Int32Array(total).fill(-1)
    const start = Math.floor(rand() * sectors[0])
    const stack = [start]
    seen[start] = 1
    while (stack.length > 0) {
      const id = stack[stack.length - 1]
      const [k, j] = cellOf(id)
      const next = neighbours(k, j).filter(([nb]) => !seen[nb])
      if (next.length === 0) { stack.pop(); continue }
      const [nb, open] = next[Math.floor(rand() * next.length)]
      open()
      seen[nb] = 1
      parent[nb] = id
      stack.push(nb)
    }
    // The entrance: the outer cell deepest along the carve from the door, so the middle is the far end of the walk.
    const door = Math.floor(rand() * sectors[0])
    wallIn[0][door] = 0
    const depth = new Int32Array(total).fill(-1)
    const queue = [door]
    depth[door] = 0
    for (let q = 0; q < queue.length; q++) {
      const [k, j] = cellOf(queue[q])
      for (const [nb] of neighbours(k, j)) {
        if (depth[nb] >= 0 || (parent[nb] !== queue[q] && parent[queue[q]] !== nb)) continue
        depth[nb] = depth[queue[q]] + 1
        queue.push(nb)
      }
    }
    let entrance = 0
    for (let j = 1; j < sectors[rings - 1]; j++) if (depth[offs[rings - 1] + j] > depth[offs[rings - 1] + entrance]) entrance = j
    wallOut[entrance] = 0
    const interior = []
    for (let k = 0; k < rings; k++) {
      for (let j = 0; j < sectors[k]; j++) {
        if (wallCw[k][j]) interior.push([wallCw[k], j])
        if (k > 0 && wallIn[k][j]) interior.push([wallIn[k], j])
      }
    }
    for (let l = Math.round(LABYRINTH.loops * total); l > 0 && interior.length > 0; l--) {
      const [arr, j] = interior.splice(Math.floor(rand() * interior.length), 1)[0]
      arr[j] = 0
    }

    const tmp = [0, 0]
    const at = (r, a) => warp(s, r, a, tmp)
    const bearing = (t, n) => s.a0 + (t * TAU) / n
    // The ring wall on boundary k (0..rings): its intervals, and whether interval t stands.
    const boundN = (k) => sectors[Math.min(k, rings - 1)]
    const boundWall = (k, t) => {
      const n = boundN(k)
      t = ((t % n) + n) % n
      return k < rings ? wallIn[k][t] === 1 : wallOut[t] === 1
    }
    const lines = []
    const sampleArc = (r, t0, t1, n) => {
      const pts = []
      const steps = Math.max(1, Math.ceil((r * (t1 - t0) * TAU) / n / SAMPLE))
      for (let q = 0; q <= steps; q++) {
        at(r, bearing(t0 + ((t1 - t0) * q) / steps, n))
        pts.push(tmp[0], tmp[1])
      }
      return pts
    }
    // The outer wall: one arc round from the entrance's far post to its near one.
    const nOut = sectors[rings - 1], rO = bound(rings)
    const gateHalf = (LABYRINTH.gate / 2 / (rO * TAU)) * nOut
    lines.push({ xz: new Float32Array(sampleArc(rO, entrance + 0.5 + gateHalf, entrance + 0.5 + nOut - gateHalf, nOut)), closed: false })
    for (let k = 0; k < rings; k++) {
      const n = boundN(k), r = bound(k)
      let gap = -1
      for (let t = 0; t < n && gap < 0; t++) if (!boundWall(k, t)) gap = t
      if (gap < 0) {
        const pts = sampleArc(r, 0, n, n)
        pts.length -= 2
        lines.push({ xz: new Float32Array(pts), closed: true })
        continue
      }
      for (let t = gap + 1; t <= gap + n; t++) {
        if (!boundWall(k, t)) continue
        let e = t
        while (e + 1 < gap + n + 1 && boundWall(k, e + 1)) e++
        lines.push({ xz: new Float32Array(sampleArc(r, t, e + 1, n)), closed: false })
        t = e
      }
    }
    // Radial walls, chained out across a boundary no ring wall touches there, trimmed where one does.
    const touches = (k, t, n) => {
      if (k === rings) return true
      const f = boundN(k) / n
      return boundWall(k, t * f - 1) || boundWall(k, t * f)
    }
    const used = sectors.map((n) => new Uint8Array(n))
    for (let k = 0; k < rings; k++) {
      for (let j = 0; j < sectors[k]; j++) {
        if (!wallCw[k][j] || used[k][j]) continue
        const t = j + 1, n = sectors[k]
        let kk = k, jj = j
        used[k][j] = 1
        while (kk + 1 < rings && !touches(kk + 1, jj + 1, sectors[kk])) {
          const j2 = ((jj + 1) * sectors[kk + 1]) / sectors[kk] - 1
          if (!wallCw[kk + 1][j2]) break
          kk++
          jj = j2
          used[kk][jj] = 1
        }
        const r0 = bound(k), r1 = bound(kk + 1)
        const pts = []
        const steps = Math.max(1, Math.ceil((r1 - r0) / SAMPLE))
        for (let q = 0; q <= steps; q++) {
          at(r0 + ((r1 - r0) * q) / steps, bearing(t, n))
          pts.push(tmp[0], tmp[1])
        }
        lines.push({ xz: trim(new Float32Array(pts), touches(k, t, n) ? JOIN : 0, touches(kk + 1, jj + 1, sectors[kk]) ? JOIN : 0), closed: false })
      }
    }

    let segCount = 0
    for (const l of lines) segCount += l.xz.length / 2 - (l.closed ? 0 : 1)
    const segments = new Float32Array(segCount * 4)
    let w = 0
    for (const l of lines) {
      const p = l.xz, np = p.length / 2
      for (let q = 0; q < np - (l.closed ? 0 : 1); q++) {
        const q2 = (q + 1) % np
        segments[w++] = p[q * 2]; segments[w++] = p[q * 2 + 1]; segments[w++] = p[q2 * 2]; segments[w++] = p[q2 * 2 + 1]
      }
    }
    const hn = Math.ceil((2 * s.reach) / HASH) + 1
    const hash = { x0: s.cx - s.reach, z0: s.cz - s.reach, n: hn, cells: new Array(hn * hn).fill(null) }
    for (let q = 0; q < segCount; q++) {
      const k = q * 4
      const i0 = Math.max(0, Math.floor((Math.min(segments[k], segments[k + 2]) - HASH_PAD - hash.x0) / HASH))
      const i1 = Math.min(hn - 1, Math.floor((Math.max(segments[k], segments[k + 2]) + HASH_PAD - hash.x0) / HASH))
      const j0 = Math.max(0, Math.floor((Math.min(segments[k + 1], segments[k + 3]) - HASH_PAD - hash.z0) / HASH))
      const j1 = Math.min(hn - 1, Math.floor((Math.max(segments[k + 1], segments[k + 3]) + HASH_PAD - hash.z0) / HASH))
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) (hash.cells[j * hn + i] ??= []).push(q)
    }

    const cells = []
    for (let k = 0; k < rings; k++) for (let j = 0; j < sectors[k]; j++) cells.push(at(bound(k) + P / 2, bearing(j + 0.5, sectors[k])).slice())
    const mouth = at(rO + 2, bearing(entrance + 0.5, nOut)).slice()
    const torches = [at(rO + TORCH_OUT, bearing(entrance + 0.5 - gateHalf, nOut)).slice(), at(rO + TORCH_OUT, bearing(entrance + 0.5 + gateHalf, nOut)).slice()]
    const unit = (x, z) => { const d = Math.hypot(x, z); return [x / d, z / d] }

    // The towers: dead ends (one way out, into another cell) spread by farthest point from each other and the mouth.
    const deadEnds = []
    for (let k = 0; k < rings; k++) {
      const n = sectors[k]
      for (let j = 0; j < n; j++) {
        const ways = []
        if (!wallCw[k][j]) ways.push(offs[k] + ((j + 1) % n))
        if (!wallCw[k][(j - 1 + n) % n]) ways.push(offs[k] + ((j - 1 + n) % n))
        if (!wallIn[k][j]) ways.push(k > 0 ? offs[k - 1] + Math.floor((j * sectors[k - 1]) / n) : -1)
        if (k + 1 < rings) {
          const f = sectors[k + 1] / n
          for (let q = 0; q < f; q++) if (!wallIn[k + 1][j * f + q]) ways.push(offs[k + 1] + j * f + q)
        } else if (!wallOut[j]) ways.push(-1)
        if (ways.length === 1 && ways[0] >= 0) deadEnds.push([offs[k] + j, ways[0]])
      }
    }
    // A dead end's tower: its corners set in the polar grid before the warp, so it twists with its cell's walls; its ladder on the face nearest the way out. None where the ladder's foot meets a wall, as when the way out is half of a split cell's outer side.
    const towerOf = ([id, way]) => {
      const [k, j] = cellOf(id)
      const rc = bound(k) + P / 2, ac = bearing(j + 0.5, sectors[k])
      const corners = towerCorners.map(([cu, cv]) => at(rc + cu * TOWER.half, ac + (cv * TOWER.half) / rc).slice())
      const [wx, wz] = unit(cells[way][0] - cells[id][0], cells[way][1] - cells[id][1])
      let ux = 0, uz = 0
      for (let f = 0; f < 4; f++) {
        const [fx, fz] = unit((corners[f][0] + corners[(f + 1) % 4][0]) / 2 - cells[id][0], (corners[f][1] + corners[(f + 1) % 4][1]) / 2 - cells[id][1])
        if (f === 0 || fx * wx + fz * wz > ux * wx + uz * wz) [ux, uz] = [fx, fz]
      }
      const [x, z] = cells[id]
      return hashedWallAt(hash, segments, x + ux * TOWER.foot, z + uz * TOWER.foot, POST_R + FOOT_CLEAR) ? null : { x, z, ux, uz, corners, cell: id }
    }
    const spots = deadEnds.map(towerOf).filter((t) => t !== null)
    const towers = []
    const want = Math.min(spots.length, Math.max(TOWER.least, Math.round(total / TOWER.perCells)))
    const far = (t) => {
      let d = Math.hypot(t.x - mouth[0], t.z - mouth[1])
      for (const o of towers) d = Math.min(d, Math.hypot(t.x - o.x, t.z - o.z))
      return d
    }
    while (towers.length < want) {
      let best = null
      for (const t of spots) if (!towers.includes(t) && (best === null || far(t) > far(best))) best = t
      towers.push(best)
    }
    const [ax, az] = unit(cells[door][0] - s.cx, cells[door][1] - s.cz)
    const scaffold = s.tower ? scaffoldOf({ cx: s.cx, cz: s.cz, ux: ax, uz: az }, regionHash(s.rx, s.rz, this.seed ^ 0x5ca4401d)) : null
    const [altarX, altarZ] = scaffold ? bayPoint(scaffold, scaffold.altar.i, scaffold.altar.j, 0, 0, [0, 0]) : [s.cx, s.cz]
    const altar = { x: altarX, z: altarZ, ux: ax, uz: az }
    const behind = scaffold ? (SCAFFOLD.bay * SCAFFOLD.bays) / 2 + 0.6 : BEACON.behind
    const beacon = [s.cx - ax * behind, s.cz - az * behind]
    // The walkable graph: node `total` is the middle, every opening a way both sides hold, the entrance none.
    const middle = at(C * (scaffold ? SCAFFOLD_NODE : MIDDLE_NODE), bearing(door + 0.5, sectors[0])).slice()
    const ways = Array.from({ length: total + 1 }, () => [])
    const join = (a, b, r, t, n) => {
      const [x, z] = at(r, bearing(t, n))
      ways[a].push({ to: b, x, z })
      ways[b].push({ to: a, x, z })
    }
    join(door, total, C, door + 0.5, sectors[0])
    for (let k = 0; k < rings; k++) {
      const n = sectors[k]
      for (let j = 0; j < n; j++) {
        if (!wallCw[k][j]) join(offs[k] + j, offs[k] + ((j + 1) % n), bound(k) + P / 2, j + 1, n)
        if (k > 0 && !wallIn[k][j]) join(offs[k] + j, offs[k - 1] + Math.floor((j * sectors[k - 1]) / n), bound(k), j + 0.5, n)
      }
    }
    m = { site: s, sectors, offs, wallCw, wallIn, wallOut, entrance, door, lines, segments, hash, cells, centre: [s.cx, s.cz], middle, ways, mouth, torches, towers, altar, beacon, scaffold, scaffoldFrom: -1, _posts: null, _carrots: null, _route: null }
    this._mazes.set(key, m)
    return m
  }

  /** The carrots of footprint `s`'s dead ends (cells with one way out) as [[x, z]], memoized: 1 to CARROTS.most each, at its back or amid a tower's posts. */
  carrotsOf(s) {
    const m = this.mazeOf(s)
    if (m._carrots !== null) return m._carrots
    const rand = mulberry32(regionHash(s.rx, s.rz, this.seed ^ 0x43415252))
    const out = []
    const towers = new Map(m.towers.map((t) => [t.cell, t]))
    for (let id = 0; id < m.cells.length; id++) {
      if (m.ways[id].length !== 1) continue
      const w = m.ways[id][0], t = towers.get(id)
      let [x, z] = m.cells[id]
      const d = Math.hypot(w.x - x, w.z - z), ux = (w.x - x) / d, uz = (w.z - z) / d
      const back = t ? 0 : CARROTS.back, spread = t ? CARROTS.under : CARROTS.spread
      if (t) {
        x = t.corners.reduce((a, c) => a + c[0], 0) / 4
        z = t.corners.reduce((a, c) => a + c[1], 0) / 4
      }
      const n = 1 + Math.floor(rand() * CARROTS.most)
      for (let i = 0; i < n; i++) {
        const side = n === 1 ? 0 : spread * ((2 * i) / (n - 1) - 1) + (rand() - 0.5) * 0.05
        out.push([x - ux * back - uz * side, z - uz * back + ux * side])
      }
    }
    m._carrots = out
    return out
  }

  /**
   * Every post of footprint `s`'s walls as a Float32Array of POST_STRIDE per post, memoized: packed along each line by
   * girth and crack (POST_GIRTH, CRACK), both ends of an open line standing a post. `roll` in [0, 1) seeds the post's
   * shape and pose (render/palisades.js postPose).
   */
  postsOf(s) {
    const m = this.mazeOf(s)
    if (m._posts !== null) return m._posts
    const rand = mulberry32(regionHash(s.rx, s.rz, this.seed ^ 0x2f5a1c37))
    const R = POST_R * POST_FACE
    const girthOf = () => POST_GIRTH[0] + rand() * (POST_GIRTH[1] - POST_GIRTH[0])
    const crackOf = () => (rand() < CRACK.open ? CRACK.width[0] + rand() * (CRACK.width[1] - CRACK.width[0]) : -CRACK.snug * rand())
    const out = []
    for (const l of m.lines) {
      const p = l.xz, np = p.length / 2
      const cum = [0]
      for (let q = 1; q < np + (l.closed ? 1 : 0); q++) {
        const a = (q - 1) * 2, b = (q % np) * 2
        cum.push(cum[q - 1] + Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1]))
      }
      const L = cum[cum.length - 1]
      // Posts rolled on until their run passes the line, then the count whose run lands nearer it kept and every girth scaled to land it exactly. crack[i] follows post i; a closed run ends on the joint back to post 0.
      const girth = [girthOf()], crack = [crackOf()]
      let open = 0, cracks = 0
      const run = () => (l.closed ? open + R * (girth[girth.length - 1] + girth[0]) + crack[crack.length - 1] : open)
      const least = l.closed ? 3 : 2
      let before = Infinity
      while (girth.length < least || run() < L) {
        before = run()
        open += R * girth[girth.length - 1] + crack[crack.length - 1]
        cracks += crack[crack.length - 1]
        girth.push(girthOf())
        crack.push(crackOf())
        open += R * girth[girth.length - 1]
      }
      if (girth.length > least && Math.abs(before - L) < Math.abs(run() - L)) {
        open -= R * (girth[girth.length - 2] + girth[girth.length - 1]) + crack[crack.length - 2]
        cracks -= crack[crack.length - 2]
        girth.pop()
        crack.pop()
      }
      if (l.closed) cracks += crack[crack.length - 1]
      const count = girth.length
      const k = (L - cracks) / (run() - cracks)
      for (let i = 0; i < count; i++) girth[i] *= k
      let q = 0, d = 0
      for (let i = 0; i < count; i++) {
        if (i > 0) d += R * (girth[i - 1] + girth[i]) + crack[i - 1]
        while (q < cum.length - 2 && cum[q + 1] < d) q++
        const a = q * 2, b = ((q + 1) % np) * 2
        const seg = cum[q + 1] - cum[q]
        if (!(seg > 0)) throw new Error(`Labyrinths.postsOf: a wall line repeats a point at (${p[a]}, ${p[a + 1]})`)
        const f = Math.min(1, (d - cum[q]) / seg)
        out.push(p[a] + (p[b] - p[a]) * f, p[a + 1] + (p[b + 1] - p[a + 1]) * f, (p[b] - p[a]) / seg, (p[b + 1] - p[a + 1]) / seg, rand() * TAU, rand(), girth[i], 1)
      }
    }
    for (const t of m.towers) for (const [x, z] of t.corners) out.push(x, z, t.ux, t.uz, rand() * TAU, rand(), TOWER.girth, TOWER.height / POST_HEIGHT)
    if (m.scaffold !== null) {
      m.scaffoldFrom = out.length / POST_STRIDE
      for (const [x, z] of postsAt(m.scaffold)) out.push(x, z, m.scaffold.ux, m.scaffold.uz, rand() * TAU, rand(), SCAFFOLD.girth, SCAFFOLD.post / POST_HEIGHT)
    }
    m._posts = new Float32Array(out)
    return m._posts
  }

  /** The footprint of the labyrinth whose outer wall's line (x, z) is inside, or null. */
  labyrinthAt(x, z) {
    return this.insideAt(x, z) ? this.siteAt(x, z) : null
  }

  /** `{ x, y, z, heading }` ENTRANCE_OUT metres outside `s`'s gate, facing in; heading is the creatures' convention (forward (cos, -sin)). */
  entranceOf(s) {
    const m = this.mazeOf(s)
    const [[ax, az], [bx, bz]] = m.torches
    const mx = (ax + bx) / 2, mz = (az + bz) / 2
    const d = Math.hypot(m.mouth[0] - mx, m.mouth[1] - mz)
    const ox = (m.mouth[0] - mx) / d, oz = (m.mouth[1] - mz) / d
    const x = mx + ox * ENTRANCE_OUT, z = mz + oz * ENTRANCE_OUT
    return { x, y: this.ground.heightAt(x, z), z, heading: Math.atan2(oz, -ox) }
  }

  /**
   * The solved route from the gate to the prize, memoized as `{ walk, up, points, ladders }`: `points` [x, z] along the ground from the gate through the cells to the middle's node, then (a tower labyrinth) to its first ladder's foot; `walk` the metres walked in all, the scaffold's included (a bay to the next is `SCAFFOLD.bay`, a drop is free), `up` the metres climbed up ladders, `ladders` the scaffold ladders it climbs in order as `{ l, i, j, d }`.
   */
  routeOf(s) {
    const m = this.mazeOf(s)
    if (m._route !== null) return m._route
    const total = m.cells.length
    const first = m.offs[s.rings - 1] + m.entrance
    const prev = new Int32Array(total + 1).fill(-2)
    prev[first] = -1
    const queue = [first]
    for (let q = 0; q < queue.length; q++) for (const w of m.ways[queue[q]]) if (prev[w.to] === -2) { prev[w.to] = queue[q]; queue.push(w.to) }
    if (prev[total] === -2) throw new Error(`Labyrinths.routeOf: the middle is not reached from the entrance of ${s.rx},${s.rz}`)
    const ids = []
    for (let id = total; id !== -1; id = prev[id]) ids.unshift(id)
    const gate = this.entranceOf(s)
    const points = [[gate.x, gate.z], m.cells[first]]
    for (let q = 1; q < ids.length; q++) {
      const w = m.ways[ids[q - 1]].find((o) => o.to === ids[q])
      points.push([w.x, w.z], ids[q] === total ? m.middle : m.cells[ids[q]])
    }
    const out = { walk: 0, up: 0, points, ladders: [] }
    const walkTo = (p) => {
      const o = out.points[out.points.length - 1]
      out.walk += Math.hypot(p[0] - o[0], p[1] - o[1])
      out.points.push(p)
    }
    for (let q = 1; q < points.length; q++) out.walk += Math.hypot(points[q][0] - points[q - 1][0], points[q][1] - points[q - 1][1])
    if (m.scaffold !== null) this._climbRoute(m, out, walkTo)
    else walkTo([m.altar.x, m.altar.z])
    m._route = out
    return out
  }

  // Extends `out` over the scaffold: `walkTo` the first ladder's foot by groundWay and each later one's from the bay it leaves, then the cheapest way from the ground to the plank (a bay's step costs its width at CLOCK.walk, a ladder up its rise at CLOCK.climb, a drop nothing, a ladder down is never taken), then to the altar.
  _climbRoute(m, out, walkTo) {
    const sc = m.scaffold, ground = (x, z) => this.ground.heightAt(x, z)
    const ids = routeOf(sc, (kind) => (kind === 'walk' ? SCAFFOLD.bay / CLOCK.walk : kind === 'up' ? SCAFFOLD.rise / CLOCK.climb : kind === 'drop' ? 0 : Infinity))
    for (let q = 1; q < ids.length; q++) {
      const a = placeOf(ids[q - 1]), b = placeOf(ids[q])
      if (b.l > a.l) {
        const bay = a.l === 0 ? b : a
        const ld = sc.ladders.find((o) => o.l === a.l && o.i === bay.i && o.j === bay.j)
        const { foot, exit } = ladderSpots(sc, ld)
        if (a.l === 0) for (const p of groundWay(sc, out.points[out.points.length - 1], bay.i, bay.j)) walkTo(p)
        walkTo(foot)
        out.up += a.l === 0 ? levelY(sc, ground, 1) - ground(foot[0], foot[1]) : SCAFFOLD.rise
        out.ladders.push({ l: ld.l, i: ld.i, j: ld.j, d: ld.d })
        out.points.push(exit)
      } else if (b.l === a.l) walkTo(bayPoint(sc, b.i, b.j, 0, 0, [0, 0]))
    }
    walkTo(bayPoint(sc, sc.altar.i, sc.altar.j, 0, 0, [0, 0]))
  }

  /** The nodes of `s`'s graph from `from` to `to`, `from` first, into `path`. */
  pathOf(s, from, to, path) {
    const m = this.mazeOf(s), n = m.cells.length + 1
    if (_parent.length < n) _parent = new Int32Array(n)
    const parent = _parent.fill(-1, 0, n)
    _queue.length = 0
    _queue.push(from)
    parent[from] = from
    for (let q = 0; q < _queue.length && parent[to] < 0; q++) for (const w of m.ways[_queue[q]]) if (parent[w.to] < 0) { parent[w.to] = _queue[q]; _queue.push(w.to) }
    if (parent[to] < 0) throw new Error(`Labyrinths.pathOf: no way from node ${from} to ${to} in ${s.rx},${s.rz}`)
    path.length = 0
    for (let id = to; id !== from; id = parent[id]) path.push(id)
    path.push(from)
    return path.reverse()
  }

  /**
   * Into `out` [x, z]: where a walker at (x, z) bound for (tx, tz) aims next so it keeps to `s`'s paths. The way is laid out as
   * points -- in from outside by a porch on the gate's line at `s.reach` and the gate (entranceOf), each opening and the next
   * node's middle (its own first), out the same way -- and the aim is the farthest of the next few in a straight line AIM_PAD
   * clear of every wall. Outside with none in sight, it steps straight out past `s.reach`, then goes round at the porch's radius.
   */
  aimOf(s, x, z, tx, tz, out) {
    const m = this.mazeOf(s), inside = m.offs[s.rings - 1] + m.entrance
    const node = this.nodeAt(s, x, z), goal = this.nodeAt(s, tx, tz)
    const pts = _pts
    pts.length = 0
    if (node !== -1 || goal !== -1) {
      const g = this.entranceOf(s), ox = m.mouth[0] - s.cx, oz = m.mouth[1] - s.cz, k = (s.reach + 1) / Math.hypot(ox, oz)
      const porch = [s.cx + ox * k, s.cz + oz * k], gate = [g.x, g.z]
      const from = node === -1 ? inside : node, path = this.pathOf(s, from, goal === -1 ? inside : goal, _path)
      const mid = (id) => (id === m.cells.length ? m.middle : m.cells[id])
      pts.push(...(node === -1 ? [porch, gate] : []), mid(from))
      for (let q = 1; q < path.length; q++) {
        const w = m.ways[path[q - 1]].find((v) => v.to === path[q])
        pts.push([w.x, w.z], mid(path[q]))
      }
      if (goal === -1) pts.push(gate, porch)
    }
    pts.push([tx, tz])
    for (let q = Math.min(pts.length, AIM_AHEAD) - 1; q >= 0; q--) if (this._clear(x, z, pts[q][0], pts[q][1])) return put(out, pts[q][0], pts[q][1])
    if (node !== -1) return put(out, pts[0][0], pts[0][1])
    const a = Math.atan2(z - s.cz, x - s.cx), b = Math.atan2(pts[0][1] - s.cz, pts[0][0] - s.cx)
    if (Math.hypot(x - s.cx, z - s.cz) < s.reach) return put(out, s.cx + Math.cos(a) * (s.reach + 1), s.cz + Math.sin(a) * (s.reach + 1))
    const round = a + Math.sign(Math.atan2(Math.sin(b - a), Math.cos(b - a))) * 0.4
    return put(out, s.cx + Math.cos(round) * (s.reach + 1), s.cz + Math.sin(round) * (s.reach + 1))
  }

  // Whether the straight line from (x, z) to (tx, tz) keeps AIM_PAD clear of every wall.
  _clear(x, z, tx, tz) {
    const n = Math.ceil(Math.hypot(tx - x, tz - z) / 0.2)
    for (let i = 1; i <= n; i++) if (this.wallAt(x + ((tx - x) * i) / n, z + ((tz - z) * i) / n, AIM_PAD)) return false
    return true
  }

  /** Seconds she is given for `s`'s solved route (routeOf): its walking at CLOCK.walk and its climbing at CLOCK.climb. */
  timeLimit(s) {
    const r = this.routeOf(s)
    return r.walk / CLOCK.walk + r.up / CLOCK.climb
  }
}

/** The points from `from` (outside the scaffold) to bay (ti, tj)'s middle along the ground: in through the middle of the nearest outer edge, where no post stands, then bay middle to bay middle. */
function groundWay(sc, from, ti, tj) {
  const half = (SCAFFOLD.bay * SCAFFOLD.bays) / 2, n = SCAFFOLD.bays
  const dx = from[0] - sc.cx, dz = from[1] - sc.cz
  const a = dx * sc.ux + dz * sc.uz, b = dx * sc.vx + dz * sc.vz
  const idx = (c) => Math.min(n - 1, Math.max(0, Math.floor(c / SCAFFOLD.bay + n / 2)))
  let i = idx(a), j = idx(b)
  const out = []
  const mid = (c) => (c - (n - 1) / 2) * SCAFFOLD.bay
  if (Math.abs(a) >= Math.abs(b)) { i = a > 0 ? n - 1 : 0; out.push(bayPoint(sc, i, j, Math.sign(a) * (half + 0.5) - mid(i), 0, [0, 0])) }
  else { j = b > 0 ? n - 1 : 0; out.push(bayPoint(sc, i, j, 0, Math.sign(b) * (half + 0.5) - mid(j), [0, 0])) }
  for (; i !== ti; i += Math.sign(ti - i)) out.push(bayPoint(sc, i, j, 0, 0, [0, 0]))
  for (; j !== tj; j += Math.sign(tj - j)) out.push(bayPoint(sc, i, j, 0, 0, [0, 0]))
  out.push(bayPoint(sc, i, j, 0, 0, [0, 0]))
  return out
}

/** The polyline `xz` with `t0` metres cut off its start and `t1` off its end. */
function trim(xz, t0, t1) {
  if (t0 === 0 && t1 === 0) return xz
  const np = xz.length / 2
  const cum = [0]
  for (let q = 1; q < np; q++) cum.push(cum[q - 1] + Math.hypot(xz[q * 2] - xz[q * 2 - 2], xz[q * 2 + 1] - xz[q * 2 - 1]))
  const L = cum[np - 1]
  if (t0 + t1 >= L) throw new Error(`Labyrinths: a ${L.toFixed(2)} m wall cannot lose ${t0 + t1} m at its joins`)
  const point = (d) => {
    let q = 0
    while (q < np - 2 && cum[q + 1] < d) q++
    const f = (d - cum[q]) / (cum[q + 1] - cum[q])
    return [xz[q * 2] + (xz[q * 2 + 2] - xz[q * 2]) * f, xz[q * 2 + 1] + (xz[q * 2 + 3] - xz[q * 2 + 1]) * f]
  }
  const out = [...point(t0)]
  for (let q = 1; q < np - 1; q++) if (cum[q] > t0 && cum[q] < L - t1) out.push(xz[q * 2], xz[q * 2 + 1])
  out.push(...point(L - t1))
  return new Float32Array(out)
}
