// ---------------------------------------------------------------------------
// Boulder mazes (DESIGN.md §41): patches of wood walled into a labyrinth by
// house-sized boulders standing shoulder to shoulder.
//
// Three-free and pure: a maze is a function of the world seed, its region cell
// and the ground, generated on first ask and memoized. The rocks' `maze` bed
// stands a boulder on every wall block; the biome field lifts the cover over
// every footprint, so a maze is always in the trees.
//
// MEMOIZED AGAINST THE GROUND AS FIRST ASKED: a sculpt does not move a maze
// already sited, and every holder (main thread, terrain worker) must site it
// off the same surface or the wood and the walls part company.
// ---------------------------------------------------------------------------

import { mulberry32, smoothstep } from '../../sim/mathx.js'
import { WORLD_HALF } from '../config.js'

export const MAZE = {
  // Metres per region cell; a cell holds one maze at odds `chance`.
  region: 450,
  chance: 0.9,
  // Metres per block of the maze grid. A wall block holds one boulder, so this
  // is the boulders' pitch along a wall and half the pitch between the walls of
  // a corridor; rocks.js's maze bed is sized off it.
  block: 7,
  // Maze cells per side, rolled per maze; the grid is 2n+1 blocks.
  cells: [6, 10],
  // Interior walls knocked out after the carve, per cell: a few loops, so a
  // wrong turn is not always a dead end.
  loops: 0.08,
  // Metres of full forest the biome holds past the footprint's edge, and then
  // the metres it eases back to the field's own cover over.
  wood: 10,
  fray: 25,
  // Positions tried per region for one whose disc is all gentle ground. The
  // rock bed refuses a block past its own 30 degrees, and a refused block is a
  // hole in a wall, so this sits under it with room for the jitter.
  tries: 48,
  maxSlopeDeg: 24,
}

// rocks.js PLACEMENT_CELL and SHORE_RISE, so the siting and the bed read one slope and one shore.
const SLOPE_CELL = 4.0
const SHORE_RISE = 1.6
const MAX_TAN = Math.tan((MAZE.maxSlopeDeg * Math.PI) / 180)
// The wobbled disc's widest reach, in blocks per block side (mazeOf's edge at its peak, 0.59 of n cells).
const DISC = 0.6

// What a block is: open, or a wall running along x or along z. A post where walls meet runs with the one along x if it has one.
export const OPEN = 0
export const WALL_X = 1
export const WALL_Z = 2

const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1]]

function regionHash(rx, rz, seed) {
  let h = Math.imul(rx | 0, 0x2c1b3c6d) ^ Math.imul(rz | 0, 0x297a2d39) ^ Math.imul(seed | 0, 0x68e31da4) ^ 0x4d415a45
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

export class BoulderMazes {
  /** `ground` is the world's V2Height; only its `scatterAt` is read. */
  constructor({ seed, ground }) {
    if (typeof seed !== 'number' || !Number.isFinite(seed)) throw new Error(`BoulderMazes: seed must be a finite number, got ${seed}`)
    if (typeof ground?.scatterAt !== 'function') throw new Error('BoulderMazes: ground must be the height field (scatterAt), which the mazes are sited on')
    this.seed = seed
    this.ground = ground
    this._g = { h: 0, tan: 0 }
    this._sites = new Map()
    this._mazes = new Map()
  }

  /**
   * Region (rx, rz)'s footprint, or null: `{ x0, z0, n, nb, cx, cz, r }`, the
   * block grid's corner (on the world's BLOCK lattice), cells and blocks per
   * side, its centre and its radius. The first of `tries` positions that is in
   * the world and on gentle ground, or null if none is; no maze is built, so the
   * biome can ask it per vertex.
   */
  siteOf(rx, rz) {
    const key = rx * 0x10000 + rz
    let s = this._sites.get(key)
    if (s !== undefined) return s
    const rand = mulberry32(regionHash(rx, rz, this.seed))
    s = null
    if (rand() < MAZE.chance) {
      const n = MAZE.cells[0] + Math.floor(rand() * (MAZE.cells[1] - MAZE.cells[0] + 1))
      const nb = 2 * n + 1
      const side = nb * MAZE.block
      const margin = MAZE.wood + MAZE.fray
      const room = MAZE.region - side - 2 * margin
      for (let t = 0; t < MAZE.tries && s === null; t++) {
        const x0 = Math.round((rx * MAZE.region + margin + rand() * room) / MAZE.block) * MAZE.block
        const z0 = Math.round((rz * MAZE.region + margin + rand() * room) / MAZE.block) * MAZE.block
        if (this._fits(x0, z0, nb)) s = { rx, rz, x0, z0, n, nb, cx: x0 + side / 2, cz: z0 + side / 2, r: side / 2 }
      }
    }
    this._sites.set(key, s)
    return s
  }

  /**
   * Whether a footprint at (x0, z0) is inside the world with its margin, and
   * every block of the disc is under MAX_TAN, dry (the rock bed's own shore
   * rise) and a block clear of any road -- each a refusal the bed would make
   * block by block, leaving a hole in a wall.
   */
  _fits(x0, z0, nb) {
    const B = MAZE.block, margin = MAZE.wood + MAZE.fray
    const side = nb * B
    if (x0 - margin < -WORLD_HALF || z0 - margin < -WORLD_HALF || x0 + side + margin > WORLD_HALF || z0 + side + margin > WORLD_HALF) return false
    const { lakes, paths } = this.ground.layers
    const c = nb / 2, reach2 = (DISC * nb) ** 2
    for (let bj = 0; bj < nb; bj++) {
      for (let bi = 0; bi < nb; bi++) {
        if ((bi + 0.5 - c) ** 2 + (bj + 0.5 - c) ** 2 > reach2) continue
        const x = x0 + (bi + 0.5) * B, z = z0 + (bj + 0.5) * B
        const g = this.ground.scatterAt(x, z, SLOPE_CELL, this._g)
        if (g.tan > MAX_TAN) return false
        const lake = lakes.levelAt(x, z), river = paths.riverLevelAt(x, z)
        const level = lake === null ? river : river === null ? lake : Math.max(lake, river)
        if (level !== null && g.h < level + SHORE_RISE) return false
        const road = paths.nearest(x, z, 'road')
        if (road !== null && road.dist < road.halfWidth + B) return false
      }
    }
    return true
  }

  /** The footprint whose region holds (x, z), or null. */
  siteAt(x, z) {
    return this.siteOf(Math.floor(x / MAZE.region), Math.floor(z / MAZE.region))
  }

  /** Every footprint whose square meets the box, for a caller that wants to skip ground with none. */
  sitesIn(x0, z0, x1, z1, out = []) {
    out.length = 0
    const r0 = Math.floor(x0 / MAZE.region), r1 = Math.floor(x1 / MAZE.region)
    const q0 = Math.floor(z0 / MAZE.region), q1 = Math.floor(z1 / MAZE.region)
    for (let rz = q0; rz <= q1; rz++) {
      for (let rx = r0; rx <= r1; rx++) {
        const s = this.siteOf(rx, rz)
        if (s === null) continue
        const side = s.nb * MAZE.block
        if (s.x0 < x1 && s.x0 + side > x0 && s.z0 < z1 && s.z0 + side > z0) out.push(s)
      }
    }
    return out
  }

  /** How much the maze at (x, z) holds the cover up: 1 over the footprint and `wood` past it, easing to 0 over `fray`. */
  woodAt(x, z) {
    const s = this.siteAt(x, z)
    if (s === null) return 0
    // 1.2 r is the wobbled disc's widest reach.
    const d = Math.hypot(x - s.cx, z - s.cz) - s.r * 1.2
    return d <= MAZE.wood ? 1 : smoothstep(MAZE.wood + MAZE.fray, MAZE.wood, d)
  }

  /** Whether a disc `r` across at (x, z) reaches a maze's ground (its wobbled disc at the widest); the region margin keeps a neighbour's maze out of reach of any rock-sized r. */
  reaches(x, z, r) {
    const s = this.siteAt(x, z)
    return s !== null && Math.hypot(x - s.cx, z - s.cz) < s.r * 1.2 + r
  }

  /** What the block holding (x, z) is: OPEN, WALL_X or WALL_Z. */
  blockAt(x, z) {
    const s = this.siteAt(x, z)
    if (s === null) return OPEN
    const bi = Math.floor((x - s.x0) / MAZE.block)
    const bj = Math.floor((z - s.z0) / MAZE.block)
    if (bi < 0 || bj < 0 || bi >= s.nb || bj >= s.nb) return OPEN
    return this.mazeOf(s).blocks[bj * s.nb + bi]
  }

  /** Which way along its axis the post holding (x, z) has its wall when it ends one (-1, +1), else 0 (mazeOf's tips). */
  tipAt(x, z) {
    const s = this.siteAt(x, z)
    if (s === null) return 0
    const bi = Math.floor((x - s.x0) / MAZE.block)
    const bj = Math.floor((z - s.z0) / MAZE.block)
    if (bi < 0 || bj < 0 || bi >= s.nb || bj >= s.nb) return 0
    return this.mazeOf(s).tips[bj * s.nb + bi]
  }

  /**
   * The maze on footprint `s`: `{ site, inside, blocks, entrances }`.
   * `inside` marks the cells of the n x n grid the maze takes (a wobbled disc),
   * `blocks` the (2n+1)^2 block grid, `entrances` the cells opened to the wood.
   *
   * Carved as a depth-first backtracker over the inside cells, which gives
   * long winding corridors, then opened in `loops` places and at two or three
   * entrances spread round the rim.
   */
  mazeOf(s) {
    const key = s.rx * 0x10000 + s.rz
    let m = this._mazes.get(key)
    if (m !== undefined) return m
    const { n, nb } = s
    const rand = mulberry32(regionHash(s.rx, s.rz, this.seed ^ 0x5bd1e995))
    // A disc with a three- and a five-lobed wobble, so no two outlines match.
    const p3 = rand() * Math.PI * 2, p5 = rand() * Math.PI * 2
    const inside = new Uint8Array(n * n)
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const dx = (i + 0.5) / n - 0.5, dz = (j + 0.5) / n - 0.5
        const a = Math.atan2(dz, dx)
        const edge = 0.5 * (1 + 0.12 * Math.sin(3 * a + p3) + 0.06 * Math.sin(5 * a + p5))
        if (Math.hypot(dx, dz) < edge) inside[j * n + i] = 1
      }
    }
    // Open edges: `ex` between (i-1, j) and (i, j) at ex[j * (n+1) + i], `ez` between (i, j-1) and (i, j) at ez[j * n + i].
    const ex = new Uint8Array(n * (n + 1))
    const ez = new Uint8Array((n + 1) * n)
    const isIn = (i, j) => i >= 0 && j >= 0 && i < n && j < n && inside[j * n + i] === 1
    const open = (i, j, di, dj) => {
      if (di !== 0) ex[j * (n + 1) + i + (di > 0 ? 1 : 0)] = 1
      else ez[(j + (dj > 0 ? 1 : 0)) * n + i] = 1
    }
    const isOpen = (i, j, di, dj) => (di !== 0 ? ex[j * (n + 1) + i + (di > 0 ? 1 : 0)] : ez[(j + (dj > 0 ? 1 : 0)) * n + i]) === 1
    // The carve, from the centre cell, which the disc always holds.
    const seen = new Uint8Array(n * n)
    const c0 = (n >> 1) * n + (n >> 1)
    const stack = [c0]
    seen[c0] = 1
    while (stack.length > 0) {
      const k = stack[stack.length - 1]
      const i = k % n, j = (k / n) | 0
      const next = []
      for (const [di, dj] of STEPS) if (isIn(i + di, j + dj) && !seen[(j + dj) * n + i + di]) next.push([di, dj])
      if (next.length === 0) { stack.pop(); continue }
      const [di, dj] = next[Math.floor(rand() * next.length)]
      open(i, j, di, dj)
      seen[(j + dj) * n + i + di] = 1
      stack.push((j + dj) * n + i + di)
    }
    // A cell the disc cut off from the centre is not maze.
    for (let k = 0; k < n * n; k++) if (!seen[k]) inside[k] = 0
    const interior = []
    const rim = []
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        if (!isIn(i, j)) continue
        for (const [di, dj] of STEPS) {
          if (di < 0 || dj < 0) continue
          if (isIn(i + di, j + dj)) { if (!isOpen(i, j, di, dj)) interior.push([i, j, di, dj]) }
        }
        for (const [di, dj] of STEPS) if (!isIn(i + di, j + dj)) rim.push([i, j, di, dj])
      }
    }
    for (let l = Math.round(MAZE.loops * n * n); l > 0 && interior.length > 0; l--) {
      const [i, j, di, dj] = interior.splice(Math.floor(rand() * interior.length), 1)[0]
      open(i, j, di, dj)
    }
    // Entrances at bearings spread round the rim, each the rim edge nearest its bearing.
    const entrances = []
    const count = 2 + (rand() < 0.5 ? 1 : 0)
    const a0 = rand() * Math.PI * 2
    for (let e = 0; e < count; e++) {
      const a = a0 + (e * Math.PI * 2) / count
      let best = null, bestD = Infinity
      for (const r of rim) {
        const [i, j, di, dj] = r
        const d = Math.hypot(i + 0.5 + di * 0.5 - n / 2 - Math.cos(a) * n, j + 0.5 + dj * 0.5 - n / 2 - Math.sin(a) * n)
        if (d < bestD) { bestD = d; best = r }
      }
      open(...best)
      entrances.push([best[0], best[1]])
    }
    // The block grid: cells at odd (bi, bj), edges at one odd, posts at both even.
    const blocks = new Uint8Array(nb * nb)
    for (let bj = 0; bj < nb; bj++) {
      for (let bi = 0; bi < nb; bi++) {
        const oddI = bi & 1, oddJ = bj & 1
        if (oddI && oddJ) continue
        if (!oddI && oddJ) {
          // Between (bi/2 - 1, j) and (bi/2, j): a wall running along z.
          const i = bi / 2, j = (bj - 1) / 2
          if ((isIn(i - 1, j) || isIn(i, j)) && ex[j * (n + 1) + i] === 0) blocks[bj * nb + bi] = WALL_Z
        } else if (oddI && !oddJ) {
          const i = (bi - 1) / 2, j = bj / 2
          if ((isIn(i, j - 1) || isIn(i, j)) && ez[j * n + i] === 0) blocks[bj * nb + bi] = WALL_X
        }
      }
    }
    // A post stands where any wall meets it, and nowhere else. One that ends
    // its wall is a tip, -1 or +1 toward the wall's side along its axis: its
    // boulder reaches 2.75 m past the block, and two tips facing over one open
    // block leave a slot she cannot pass, so rocks.js draws a tip back.
    const at = (i, j) => i >= 0 && j >= 0 && i < nb && j < nb && blocks[j * nb + i] !== OPEN
    const tips = new Int8Array(nb * nb)
    for (let bj = 0; bj < nb; bj += 2) {
      for (let bi = 0; bi < nb; bi += 2) {
        const w = at(bi - 1, bj), e = at(bi + 1, bj), s0 = at(bi, bj - 1), n0 = at(bi, bj + 1)
        if (w || e) { blocks[bj * nb + bi] = WALL_X; tips[bj * nb + bi] = e - w }
        else if (s0 || n0) { blocks[bj * nb + bi] = WALL_Z; tips[bj * nb + bi] = n0 - s0 }
      }
    }
    m = { site: s, inside, blocks, tips, entrances }
    this._mazes.set(key, m)
    return m
  }
}
