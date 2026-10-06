// A town house's inside, meshed from rollTownInterior (design/38-town-interiors.md, its means design/40-house-wealth.md): log, board, panelled or plastered walls cut for its doors and windows, a flag or plank floor, the roof's underside on its rafters, the upper floor on its joists, a slat stair, a stone hearth, and the furniture. One merged mesh per texture, lit by a per-vertex bake that stops at the walls: a room sees its own candles, windows and hearth, and its neighbours' only through the doorways between them. The group is set at the room's anchor; everything inside it is room-local metres.
import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { hash32 } from '../../sim/score.js'
import { TriFlames, TRI_FIRE } from './fire-tris.js'
import { Mesher, kit, frame, put, turn, tip, rgb, FLAT, WOOD_M, VERT, FRAG, speckleTexture, buildFlames, slab, bookAt, candleOn, sackAt, binding, shiny, SHINE, CLAY, CREAM, WAX, IRON, PEWTER, CORD, WICKER, BURLAP, MUTED, add, sub, norm, cross, LEVELS, DARK_FILL, glaze, houseUniforms, skyThroughGlass } from './interior.js'
import { CELLAR, S, DOOR, DOORWAY, PART, SLAB, footprint, grow, lines, minus, pt, rect, townCeilingAt, townRoomAt, within } from '../rooms/town-interior.js'

const TAU = 2 * Math.PI
// The outer wall's depth, as the roller insets it.
const T = 0.15
// Tessellation: the bake is per vertex, so a candle's pool needs vertices this close.
const STEP = 0.25
// Texture metres per repeat: floors and walls, the hearth's stones, the leaded panes.
const FLOOR_M = 2.0, WALL_M = 2.0, STONE_M = 1.0, LEAD_M = 0.5, EARTH_M = 1.2
const MESHES = ['floor', 'plank', 'wall', 'stone', 'grain', 'linen', 'pages', 'window']

// The bake (design/38 §Light). `amb` is the fill of a room with a window's worth of glass, DARK_FILL the share of it a windowless room, or any room at night, keeps; `bleed` of a brighter neighbour's fill comes through the doorway. A candle gives `candle` times its `i`, falling by e every `reach` metres, saturating at `cap`; the hearth is a candle of `fire` falling over `fireReach`. A doorway passes `door` of what reaches it on to the next room as a light of its own. Windows are leafkin's spill-and-beam over `spillM` and `beamM`, scaled by their glass. Under a table or a bed the fill falls to `under`.
const SHADE = { amb: 0.2, bleed: 0.3, glass: 1.2, corner: 0.5, candle: 2.4, reach: 1.0, torchReach: 1.6, cap: 1.8, fire: 3.0, fireReach: 1.7, door: 0.45, doorReach: 1.3, spill: 2.0, spillM: 1.2, beamM: 1.6, under: 0.4 }

// Medieval country colours: oak and elm browns, pewter, iron, earthenware, dyed wool.
const WOOD = (h, dl = 0) => rgb(0.065 + h * 0.035, 0.36 + h * 0.12, 0.2 + h * 0.13 + dl)
const DARKWOOD = (h) => WOOD(h, -0.08)
// Turned and oiled: plates, bowls, mugs.
const TURNED = (h) => shiny(WOOD(h), SHINE.oiled, 0.3)
const INK = shiny(rgb(0.6, 0.15, 0.1), SHINE.glaze, 0.5)
const WOOL = (h) => rgb([0.0, 0.03, 0.09, 0.3, 0.58, 0.62, 0.95][Math.floor(h * 7) % 7] + (h * 7 % 1) * 0.02, 0.38, 0.3)
// Wool a household could not afford to dye: fleece browns, oatmeal, grey. `cloth` is dyed as often as the house has the means.
const UNDYED = [rgb(0.08, 0.25, 0.36), rgb(0.1, 0.2, 0.55), rgb(0.07, 0.06, 0.42), rgb(0.06, 0.3, 0.26)]
const cloth = (room, h) => ((h * 9.37) % 1 < room.dyed ? WOOL(h) : UNDYED[Math.floor(h * 4) % 4])
const FRUIT = [rgb(0.01, 0.6, 0.38), rgb(0.2, 0.5, 0.42), rgb(0.12, 0.6, 0.48), rgb(0.85, 0.35, 0.25), rgb(0.07, 0.65, 0.45)]
const SOOT = rgb(0.06, 0.1, 0.07)

// --- textures, made in code -------------------------------------------------

/** A tiling value noise over an `L` lattice, sampled in lattice units. */
function lattice(L, seed) {
  const rng = mulberry32(seed), g = Float32Array.from({ length: L * L }, () => rng())
  const s = (t) => t * t * (3 - 2 * t)
  return (u, v) => {
    const i = Math.floor(u), k = Math.floor(v), fu = s(u - i), fv = s(v - k)
    const a = g[((k % L + L) % L) * L + ((i % L + L) % L)], b = g[((k % L + L) % L) * L + (((i + 1) % L + L) % L)]
    const c = g[(((k + 1) % L + L) % L) * L + ((i % L + L) % L)], d = g[(((k + 1) % L + L) % L) * L + (((i + 1) % L + L) % L)]
    return a + (b - a) * fu + (c - a) * fv + (a - b - c + d) * fu * fv
  }
}

/** An n x n grey texture of `lum(x, y)` (0..1, near grey: the tint carries the colour), tiling. */
function greyTexture(n, lum) {
  const d = new Uint8Array(n * n * 4)
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const v = Math.max(0, Math.min(255, Math.round(lum(x, y) * 255)))
    d.set([v, v, v, 255], (y * n + x) * 4)
  }
  const t = new THREE.DataTexture(d, n, n)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.magFilter = THREE.LinearFilter
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.generateMipmaps = true
  t.anisotropy = 4
  t.needsUpdate = true
  return t
}

/** Boards `count` to a repeat running along x (`across` false) or y, with seams, butt joints, grain and the odd knot. */
function boardsTexture(n, count, across, seed) {
  const rng = mulberry32(seed), noise = lattice(16, seed + 1), fine = lattice(64, seed + 2)
  const w = n / count, boards = Array.from({ length: count }, () => ({ l: 0.68 + rng() * 0.27, joint: rng() * n, knot: rng() < 0.35 ? [rng() * n, w * (0.3 + rng() * 0.4)] : null, phase: rng() * 10 }))
  return greyTexture(n, (x, y) => {
    const [a, b] = across ? [y, x] : [x, y]
    const bi = Math.floor(b / w), B = boards[bi], inB = b - bi * w
    let v = B.l * (0.9 + 0.12 * noise(a / n * 4, b / n * 16 + B.phase) + 0.06 * Math.sin((inB / w) * 9 + noise(a / n * 2, bi) * 6) + 0.05 * (fine(a / n * 64, b / n * 64) - 0.5))
    if (inB < 1.2 || inB > w - 0.6) v *= 0.45
    if (Math.abs(((a - B.joint) % n + n) % n) < 1) v *= 0.5
    if (B.knot) { const dx = ((a - B.knot[0]) % n + n) % n, d = Math.hypot(Math.min(dx, n - dx) / 2, inB - B.knot[1]); if (d < 3) v *= 0.55 + 0.15 * d }
    return v
  })
}

/** Squared stones in courses of random height, mortared. */
function flagTexture(n, seed) {
  const rng = mulberry32(seed), noise = lattice(32, seed + 1), wob = lattice(24, seed + 3)
  const rows = []
  for (let y = 0; y < n;) { const h = Math.min(n - y, Math.round(n * (0.17 + rng() * 0.12))); rows.push({ y, h, cuts: [] }); y += h }
  if (rows.length > 1 && rows[rows.length - 1].h < n * 0.1) { const t = rows.pop(); rows[rows.length - 1].h += t.h }
  for (const r of rows) {
    const off = rng() * n
    for (let x = 0; x < n;) { const w = Math.round(n * (0.2 + rng() * 0.22)); r.cuts.push({ x: (x + off) % n, l: 0.6 + rng() * 0.32 }); x += w }
    r.cuts.sort((a, b) => a.x - b.x)
  }
  return greyTexture(n, (x, y) => {
    const r = rows.find((q) => y >= q.y && y < q.y + q.h)
    let k = r.cuts.findIndex((c) => c.x > x) - 1
    if (k === -2) k = r.cuts.length - 1
    if (k < 0) k = r.cuts.length - 1
    const c = r.cuts[k], next = r.cuts[(k + 1) % r.cuts.length]
    const dx = Math.min(((x - c.x) % n + n) % n, ((next.x - x) % n + n) % n), dy = Math.min(y - r.y, r.y + r.h - 1 - y)
    const edge = Math.min(dx, dy) + (wob(x / n * 24, y / n * 24) - 0.5) * 3
    let v = c.l * (0.85 + 0.25 * noise(x / n * 32, y / n * 32))
    if (edge < 2) v = 0.3 + 0.08 * noise(x / 3, y / 3)
    else if (edge < 4) v *= 0.8
    return v
  })
}

/** Frame-and-panel boarding: 2 x 2 panels a repeat, stiles and rails round each sunk field. */
function panelTexture(n, seed) {
  const noise = lattice(16, seed), fine = lattice(64, seed + 1), half = n / 2, frameW = n * 0.06
  return greyTexture(n, (x, y) => {
    const px = x % half, py = y % half, edge = Math.min(px, py, half - 1 - px, half - 1 - py)
    const grain = 0.06 * Math.sin((px / half) * 40 + noise(x / n * 4, y / n * 16) * 8) + 0.05 * (fine(x / n * 64, y / n * 64) - 0.5)
    if (edge < 1) return 0.35
    if (edge < frameW) return 0.82 + grain
    if (edge < frameW + 2) return 0.5
    if (edge < frameW + 5) return 0.95
    return 0.72 + grain
  })
}

/** Diamond quarries in lead cames. */
function leadedTexture(n, seed) {
  const noise = lattice(8, seed)
  return greyTexture(n, (x, y) => {
    const u = x / n, v = y / n, a = (u + v) * 4, b = (u - v) * 4
    const da = Math.abs(a - Math.round(a)) * n / 4, db = Math.abs(b - Math.round(b)) * n / 4
    if (Math.min(da, db) < 1.6) return 0.12
    return 0.72 + 0.22 * noise(Math.floor(a) * 1.7 + 0.5, Math.floor(b) * 1.3 + 0.5) + 0.06 * Math.sin(u * 30 + v * 11)
  })
}

/** Limewash over daub, mottled. */
const plasterLum = (noise, fine, n) => (x, y) => 0.84 + 0.1 * noise(x / n * 8, y / n * 8) + 0.05 * (fine(x / n * 64, y / n * 64) - 0.5)
function plasterTexture(n, seed) { return greyTexture(n, plasterLum(lattice(8, seed), lattice(64, seed + 1), n)) }
/** Studs, a rail and a brace of dark oak through limewashed panels: two bays a repeat. */
function timberedTexture(n, seed) {
  const plaster = plasterLum(lattice(8, seed), lattice(64, seed + 1), n), grain = lattice(16, seed + 2), w = n * 0.07
  return greyTexture(n, (x, y) => {
    const bx = x % (n / 2), brace = Math.abs(bx - (y - n / 2)) / Math.SQRT2
    const oak = bx < w || Math.abs(y - n * 0.5) < w / 2 || (y > n / 2 && x < n / 2 && brace < w / 2)
    return oak ? 0.28 + 0.08 * grain(x / n * 4, y / n * 16) : plaster(x, y)
  })
}

let made = null
/** The house textures made in code, once; `shared` the leafkin interior's grain, linen and pages. */
function houseTextures(shared) {
  made ??= { plank: boardsTexture(256, 10, false, 0x91a7), flag: flagTexture(256, 0xf1a6), boards: boardsTexture(256, 8, true, 0xb0a2), panel: panelTexture(256, 0x9a7e), plaster: plasterTexture(128, 0x91a5), timbered: timberedTexture(256, 0x7b3e), leaded: leadedTexture(128, 0x1ead) }
  return { ...made, grain: shared.grain, linen: shared.linen, pages: shared.pages }
}

// --- the shell ----------------------------------------------------------------------

const uvOn = (L, u, y, m) => [u / m, y / m]
const inward = (L, s = 1) => [L.ix * s, 0, L.iz * s]

/**
 * The face of a wall along line `L` at depth `d` (+ into the room), facing in (or out with `flip`), from u0 to u1 and from y0 up to `top(u)`, less the `holes` ({ u0, u1, y0, y1 }), its rows split at `ys` so the bake can break there.
 */
function wallFace(m, L, d, u0, u1, y0, top, holes, ys, tint, { flip = false, uvM = WALL_M } = {}) {
  const us = new Set([u0, u1])
  for (const h of holes) for (const u of [h.u0, h.u1]) if (u > u0 && u < u1) us.add(u)
  const breaks = [...us].sort((a, b) => a - b), cols = []
  for (let i = 0; i + 1 < breaks.length; i++) {
    const n = Math.max(1, Math.ceil((breaks[i + 1] - breaks[i]) / STEP))
    for (let k = 0; k < n; k++) cols.push([breaks[i] + ((breaks[i + 1] - breaks[i]) * k) / n, breaks[i] + ((breaks[i + 1] - breaks[i]) * (k + 1)) / n])
  }
  const n = inward(L, flip ? -1 : 1)
  for (const [ua, ub] of cols) {
    const mid = (ua + ub) / 2, tA = top(ua), tB = top(ub), low = Math.min(tA, tB)
    const over = holes.filter((h) => mid > h.u0 && mid < h.u1)
    const Y = [...new Set([y0, ...ys, ...over.flatMap((h) => [h.y0, h.y1])].filter((y) => y >= y0 && y < low - 0.01))].sort((a, b) => a - b)
    for (let b = 0; b < Y.length; b++) {
      const ya = Y[b], last = b + 1 === Y.length
      if (over.some((h) => ya >= h.y0 - 1e-6 && ya < h.y1 - 1e-6)) continue
      const yA = last ? tA : Y[b + 1], yB = last ? tB : Y[b + 1]
      const rows = Math.max(1, Math.ceil((Math.max(yA, yB) - ya) / STEP))
      m.grid(1, rows, (i, j) => {
        const u = i ? ub : ua, y = ya + ((i ? yB : yA) - ya) * (j / rows), p = pt(L, u, d)
        return { p: [p.x, y, p.z], n, uv: uvOn(L, u, y, uvM) }
      }, tint, 1)
    }
  }
}

/** The four inner faces of a hole `h` in the wall along `L`, from its face at depth 0 out through `depth`; `sill` false leaves its foot open to the floor. */
function reveal(m, L, h, depth, tint, { sill = true, uvM = WALL_M } = {}) {
  const at = (u, y, d) => { const p = pt(L, u, d); return [p.x, y, p.z] }
  const ud = L.axis === 'x' ? [1, 0, 0] : [0, 0, 1]
  const quad = (ps, n) => m.quad(...ps.map((p, i) => m.v(p, n, [[0, 0], [depth / uvM, 0], [depth / uvM, (h.y1 - h.y0) / uvM], [0, (h.y1 - h.y0) / uvM]][i], tint)))
  quad([at(h.u0, h.y0, 0), at(h.u0, h.y0, -depth), at(h.u0, h.y1, -depth), at(h.u0, h.y1, 0)], ud)
  quad([at(h.u1, h.y0, 0), at(h.u1, h.y0, -depth), at(h.u1, h.y1, -depth), at(h.u1, h.y1, 0)], ud.map((v) => -v))
  quad([at(h.u0, h.y1, 0), at(h.u1, h.y1, 0), at(h.u1, h.y1, -depth), at(h.u0, h.y1, -depth)], [0, -1, 0])
  if (sill) quad([at(h.u0, h.y0, 0), at(h.u1, h.y0, 0), at(h.u1, h.y0, -depth), at(h.u0, h.y0, -depth)], [0, 1, 0])
}

/** A horizontal grid over rect `r` at height `y(x, z)`, facing up (`dir` 1) or down, `breaksX`/`breaksZ` kept as columns so a ridge creases where it should. */
function sheet(m, r, y, dir, tint, uvM, { breaksX = [], breaksZ = [] } = {}) {
  const axis = (a, b, extra) => {
    const out = [...new Set([a, b, ...extra.filter((v) => v > a && v < b)])].sort((p, q) => p - q), fine = []
    for (let i = 0; i + 1 < out.length; i++) { const k = Math.max(1, Math.ceil((out[i + 1] - out[i]) / STEP)); for (let j = 0; j < k; j++) fine.push(out[i] + ((out[i + 1] - out[i]) * j) / k) }
    fine.push(b)
    return fine
  }
  const xs = axis(r.x0, r.x1, breaksX), zs = axis(r.z0, r.z1, breaksZ)
  // x cross z is down, so up is the grid's -1.
  m.grid(xs.length - 1, zs.length - 1, (i, j) => ({ p: [xs[i], y(xs[i], zs[j]), zs[j]], uv: [xs[i] / uvM, zs[j] / uvM] }), tint, -dir)
}

/** A square-section timber from p0 to p1, `hw` half wide and `hh` half deep about `up`. */
function beam(m, p0, p1, hw, hh, tint, up = [0, 1, 0]) {
  const d = norm(sub(p1, p0)), len = Math.hypot(...sub(p1, p0))
  const side = norm(cross(d, Math.abs(d[0] * up[0] + d[1] * up[1] + d[2] * up[2]) > 0.95 ? [1, 0, 0] : up)), u = cross(side, d)
  const F = { x: (p0[0] + p1[0]) / 2, y: (p0[1] + p1[1]) / 2, z: (p0[2] + p1[2]) / 2, ax: side, ay: u, az: d }
  slab(m, F, [-hw, -hh, -len / 2], [hw, hh, len / 2], tint, woodUV)
}

const woodUV = (p, n) => (n[0] ? [p[2] / WOOD_M, p[1] / WOOD_M] : n[1] ? [p[0] / WOOD_M, p[2] / WOOD_M] : [p[0] / WOOD_M, p[1] / WOOD_M])
/** A hewn block in `F` from lo to hi, knocked `a` off square. */
const hewn = (m, K, F, lo, hi, tint, a = 0.008) => slab(m, K.crook(F, a), lo, hi, tint, woodUV)
/** A forged iron strap or blade from lo to hi, its edges rounded so the highlight runs over them. */
const iron = (m, K, F, lo, hi) => K.box(m, F, ...[0, 1, 2].map((a) => (lo[a] + hi[a]) / 2), ...[0, 1, 2].map((a) => (hi[a] - lo[a]) / 2), IRON, { round: 0.4, segs: 12, rows: 6, crook: 0, flat: true })

/**
 * Round logs laid in courses along `L` over the chinking behind them, set into the wall's depth so their fronts stand at its face: cut round the `holes`, stopped under `top(u)`, run on `over` past a corner into the next wall's logs. A poorer house's logs are thicker and less true (design/40-house-wealth.md).
 */
function logWall(M, L, u0, u1, top, holes, ys, room, rng, over) {
  const rough = room.rough, c = 0.22 + 0.06 * rough, dc = -T + 0.01, ud = L.axis === 'x' ? [1, 0, 0] : [0, 0, 1], RING = 4
  const a0 = u0 - over[0], a1 = u1 + over[1]
  wallFace(M.stone, L, dc + c * 0.15, a0, a1, 0, top, holes, ys, rgb(0.09, 0.18, 0.22), { uvM: STONE_M })
  for (let yc = c / 2; ; yc += c) {
    const r = c * (0.5 + (rng() - 0.5) * 0.06 * rough), y = yc + (rng() - 0.5) * 0.02 * rough, ph = rng() * TAU
    const tint = rgb(0.07 + rng() * 0.02, 0.36 - 0.1 * rough, 0.22 + rng() * 0.06 - 0.04 * rough)
    const cut = holes.filter((h) => h.y0 < y + r && h.y1 > y - r)
    const ok = (u) => top(u) - 0.02 > y + r && !cut.some((h) => u > h.u0 - 0.005 && u < h.u1 + 0.005)
    if (!ok(a0) && !ok((a0 + a1) / 2) && y > Math.max(top(a0), top(a1), top((a0 + a1) / 2))) break
    // Columns every STEP, plus each hole's edges, so a run stops flush at a window.
    const us = [...new Set([a0, a1, ...cut.flatMap((h) => [h.u0 - 0.005, h.u1 + 0.005]).filter((u) => u > a0 && u < a1)])].sort((p, q) => p - q), cols = []
    for (let i = 0; i + 1 < us.length; i++) { const k = Math.max(1, Math.ceil((us[i + 1] - us[i]) / STEP)); for (let j = 0; j < k; j++) cols.push(us[i] + ((us[i + 1] - us[i]) * j) / k) }
    cols.push(a1)
    const runs = []
    for (const u of cols) { if (!ok(u)) { runs.push([]); continue } if (!runs.length) runs.push([]); runs[runs.length - 1].push(u) }
    for (const run of runs.filter((q) => q.length > 1)) {
      const rad = (u) => r * (1 + 0.05 * rough * Math.sin(u * 1.7 + ph)), at = (u, q) => { const p = pt(L, u, dc + rad(u) * Math.cos(q)); return [p.x, y + rad(u) * Math.sin(q), p.z] }
      const q = (j) => -Math.PI / 2 + (Math.PI * j) / RING
      M.grain.grid(run.length - 1, RING, (i, j) => ({ p: at(run[i], q(j)), n: add(inward(L, Math.cos(q(j))), [0, Math.sin(q(j)), 0]), uv: [run[i] / WOOD_M, (r * q(j)) / WOOD_M] }), tint, 1)
      for (const [u, s] of [[run[0], -1], [run[run.length - 1], 1]]) {
        const n = ud.map((v) => v * s), mid = pt(L, u, dc), o = M.grain.v([mid.x, y, mid.z], n, [0, 0], tint)
        const ring = Array.from({ length: RING + 1 }, (_, j) => M.grain.v(at(u, q(j)), n, [Math.cos(q(j)) * 0.1, Math.sin(q(j)) * 0.1], tint))
        for (let j = 0; j < RING; j++) M.grain.tri(o, ring[j], ring[j + 1])
      }
    }
  }
}

/** The holes in the wall along `L` (a cell's line `name`): its windows, the front door, the doorways through to the other cells. */
function holesOn(room, cell, name, L) {
  const on = (o) => o.axis === L.axis && Math.abs(o.at - L.at) < 0.01
  const out = room.windows.filter(on).map((w) => ({ u0: w.u - w.w / 2, u1: w.u + w.w / 2, y0: w.y0, y1: w.y1, win: w }))
  if (cell.role === 'main' && name === 'front') out.push({ u0: room.door.x - DOOR.w / 2, u1: room.door.x + DOOR.w / 2, y0: 0, y1: DOOR.h, door: true })
  for (const j of room.junctions) {
    const facing = cell.role === 'main' ? { east: 'right', west: 'left', back: 'back' }[j.side] : room.cells[j.cell] === cell ? { east: 'left', west: 'right', back: 'front' }[j.side] : null
    if (facing === name) out.push({ u0: j.gap[0], u1: j.gap[1], y0: 0, y1: DOORWAY.h, depth: cell.role === 'main' ? j.P : 0, way: true })
  }
  return out
}

function buildShell(room, M, K, rng) {
  const woodWall = (dl = 0) => rgb(0.07 + room.wall.hue * 0.05, 0.3 + room.wall.hue * 0.12, 0.3 * room.wall.tone + dl)
  const wallTint = (dl = 0) => (room.wall.kind === 'plaster' || room.wall.kind === 'timbered' ? rgb(0.1 + room.wall.hue * 0.03, 0.2, 0.62 * room.wall.tone + dl) : woodWall(dl))
  const floorTint = room.floor.kind === 'earth' ? rgb(0.06 + room.floor.hue * 0.03, 0.3, 0.24 * room.floor.tone) : room.floor.kind === 'plank' ? rgb(0.07 + room.floor.hue * 0.04, 0.35, 0.28 * room.floor.tone) : rgb(0.08 + room.floor.hue * 0.06, 0.08 + room.floor.hue * 0.06, 0.42 * room.floor.tone)
  const floorM = room.floor.kind === 'earth' ? EARTH_M : FLOOR_M
  const timber = DARKWOOD(room.wall.hue)
  const ceilTint = rgb(0.07, 0.3, 0.2)
  // The roof's underside at the wall's foot, plus a little: it runs up behind the ceiling so no seam opens at a ridge.
  const roofTop = (L, d = 0) => (u) => { const p = pt(L, u, d); return townCeilingAt(room, p.x, p.z) + 0.1 }

  room.cells.forEach((cell) => {
    const Ls = lines(cell.r), main = cell.role === 'main'
    for (const [name, L] of Object.entries(Ls)) {
      const holes = holesOn(room, cell, name, L), ys = main && room.upper ? [room.U - SLAB, room.U] : []
      if (room.wall.kind === 'logs') logWall(M, L, L.lo, L.hi, roofTop(L), holes, ys, room, rng, [T, T])
      else wallFace(M.wall, L, 0, L.lo, L.hi, 0, roofTop(L), holes, ys, wallTint())
      for (const h of holes) {
        if (h.win) {
          reveal(M.wall, L, h, T, wallTint(-0.04))
          windowPane(M, K, L, h, timber)
        } else if (h.door) {
          reveal(M.wall, L, h, T, wallTint(-0.04), { sill: false })
          const p = pt(L, (h.u0 + h.u1) / 2, -T + 0.05)
          doorLeaf(M, K, { x: p.x, y: 0, z: p.z, ax: L.axis === 'x' ? [1, 0, 0] : [0, 0, 1], ay: [0, 1, 0], az: inward(L) }, h.u1 - h.u0, h.y1)
        } else if (h.depth > 0) reveal(M.wall, L, h, h.depth, wallTint(-0.04), { sill: false })
        if (!h.win && h.depth !== 0) frameAround(M, L, h, timber)
      }
      // A skirting timber along the foot of the wall, broken at its doorways. Logs instead get the floor run out under them, past the corners: they sit back in the wall's depth, and the floor stops at its face.
      const logs = room.wall.kind === 'logs', gaps = holes.filter((h) => h.y0 < 0.1 && !(logs && h.door)).sort((a, b) => a.u0 - b.u0)
      let from = logs ? L.lo - T : L.lo
      for (const g of [...gaps, logs ? { u0: L.hi + T, u1: L.hi + T } : { u0: L.hi, u1: L.hi }]) {
        if (logs && g.u0 > from) { const a = pt(L, from, 0), b = pt(L, g.u0, -T); sheet(M.floor, { x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), z0: Math.min(a.z, b.z), z1: Math.max(a.z, b.z) }, () => 0, 1, floorTint, floorM) }
        else if (!logs && g.u0 - from > 0.2) { const a = pt(L, from, 0.025), b = pt(L, g.u0, 0.025); beam(M.grain, [a.x, 0.07, a.z], [b.x, 0.07, b.z], 0.025, 0.07, timber) }
        from = g.u1
      }
    }
    // The ceiling: the roof's underside on its rafters.
    const cx = (cell.r.x0 + cell.r.x1) / 2 / S, cz = (cell.r.z0 + cell.r.z1) / 2 / S
    const mass = room.plan.masses.find((m) => Math.abs(cx - m.cx) <= m.w / 2 && Math.abs(cz - m.cz) <= m.d / 2)
    if (!mass) throw new Error(`TownInteriorView: cell ${cell.role} lies under no mass`)
    const roof = mass.roof, ridge = roof.kind === 'lean' ? [] : [S * roof.cx, S * roof.cz]
    sheet(M.plank, cell.r, (x, z) => townCeilingAt(room, x, z), -1, ceilTint, FLOOR_M, { breaksX: roof.ridgeAxis === 'z' ? [ridge[0]] : [], breaksZ: roof.ridgeAxis === 'x' ? [ridge[1]] : [] })
    rafters(M, room, cell.r, roof, timber)
  })

  // The floor, flag, plank or earth; the doorways' floors are the same.
  for (const r of room.inside) for (const q of room.cellar ? minus(r, room.cellar.hole) : [r]) sheet(M.floor, q, () => 0, 1, floorTint, floorM)
  if (room.cellar) cellarWell(M, room, wallTint(-0.02))
  for (const p of room.partitions) partition(M, room, p, wallTint(-0.02), timber)
  hearthAt(M, K, room, timber)
  if (room.upper) upperFloor(M, K, room, timber)
}

/** Rafters under a mass's roof, every so often across it, and its ridge beam. */
function rafters(M, room, r, roof, tint) {
  const below = (x, z) => [x, townCeilingAt(room, x, z) - 0.07, z]
  const along = roof.kind === 'lean' ? (roof.dir[1] === 'x' ? 'z' : 'x') : roof.ridgeAxis
  const [a0, a1] = along === 'x' ? [r.x0, r.x1] : [r.z0, r.z1]
  const n = Math.max(2, Math.round((a1 - a0) / 0.9))
  for (let i = 0; i <= n; i++) {
    const a = a0 + 0.08 + ((a1 - a0 - 0.16) * i) / n
    const across = along === 'x' ? [r.z0 + 0.02, r.z1 - 0.02] : [r.x0 + 0.02, r.x1 - 0.02]
    const pts = [across[0]]
    if (roof.kind !== 'lean') { const c = along === 'x' ? S * roof.cz : S * roof.cx; if (c > across[0] && c < across[1]) pts.push(c) }
    pts.push(across[1])
    for (let k = 0; k + 1 < pts.length; k++) {
      const p = along === 'x' ? below(a, pts[k]) : below(pts[k], a), q = along === 'x' ? below(a, pts[k + 1]) : below(pts[k + 1], a)
      beam(M.grain, p, q, 0.05, 0.07, tint)
    }
  }
  if (roof.kind !== 'lean') {
    const c = along === 'x' ? S * roof.cz : S * roof.cx
    const p = along === 'x' ? [a0, 0, c] : [c, 0, a0], q = along === 'x' ? [a1, 0, c] : [c, 0, a1]
    if (within(grow(r, 0.01), p[0], p[2])) beam(M.grain, below(p[0], p[2]).map((v, i) => (i === 1 ? v - 0.05 : v)), below(q[0], q[2]).map((v, i) => (i === 1 ? v - 0.05 : v)), 0.08, 0.1, tint)
  }
}

/** A board partition along `p.axis` at `p.at`, from p.lo to p.hi, its doorway cut and framed. */
function partition(M, room, p, tint, timber) {
  const hw = PART / 2, along = p.axis === 'x'
  const top = (u) => (p.y1 < 1e2 ? p.y1 : (along ? townCeilingAt(room, u, p.at) : townCeilingAt(room, p.at, u)) + 0.1)
  const hole = { u0: p.gap[0], u1: p.gap[1], y0: p.y0, y1: p.y0 + DOORWAY.h }
  const face = (s) => ({ axis: p.axis, at: p.at + s * hw, ix: along ? 0 : s, iz: along ? s : 0 })
  wallFace(M.wall, face(-1), 0, p.lo, p.hi, p.y0, top, [hole], [], tint)
  wallFace(M.wall, face(1), 0, p.lo, p.hi, p.y0, top, [hole], [], tint)
  reveal(M.wall, face(-1), hole, PART, tint, { sill: false })
  frameAround(M, face(-1), { ...hole, depth: PART }, timber)
}

/** A plain timber frame round a doorway `h` in the wall along `L`, proud of each face at depth `ds` (both faces by default). The posts stop short of the head's top so the two tops are not coplanar. */
function frameAround(M, L, h, tint, ds = [0.02, -(h.depth || T) - 0.02]) {
  for (const d of ds) {
    const at = (u, y) => { const p = pt(L, u, d); return [p.x, y, p.z] }
    beam(M.grain, at(h.u0 - 0.05, h.y0), at(h.u0 - 0.05, h.y1 + 0.09), 0.05, 0.025, tint, L.axis === 'x' ? [0, 0, 1] : [1, 0, 0])
    beam(M.grain, at(h.u1 + 0.05, h.y0), at(h.u1 + 0.05, h.y1 + 0.09), 0.05, 0.025, tint, L.axis === 'x' ? [0, 0, 1] : [1, 0, 0])
    beam(M.grain, at(h.u0 - 0.1, h.y1 + 0.05), at(h.u1 + 0.1, h.y1 + 0.05), 0.025, 0.05, tint)
  }
}

/** Leaded glass at the outer face of window `h`, a sill board and a timber frame round it inside. */
function windowPane(M, K, L, h, timber) {
  const at = (u, y, d) => { const p = pt(L, u, d); return [p.x, y, p.z] }
  const n = inward(L)
  const ids = [[h.u0, h.y0], [h.u1, h.y0], [h.u1, h.y1], [h.u0, h.y1]].map(([u, y]) => M.window.v(at(u, y, -T + 0.03), n, [u / LEAD_M, y / LEAD_M], rgb(0.2, 0.12, 0.85)))
  M.window.quad(...ids)
  // Mullion and transom, the transom a hair thinner so their faces at the crossing are not coplanar.
  const mu = (h.u0 + h.u1) / 2, my = h.y0 + (h.y1 - h.y0) * 0.62
  beam(M.grain, at(mu, h.y0, -T + 0.06), at(mu, h.y1, -T + 0.06), 0.03, 0.035, timber, L.axis === 'x' ? [0, 0, 1] : [1, 0, 0])
  beam(M.grain, at(h.u0, my, -T + 0.06), at(h.u1, my, -T + 0.06), 0.026, 0.035, timber)
  // The sill board stands 1 cm proud of the reveal's sill, which would otherwise z-fight its top.
  beam(M.grain, at(h.u0 - 0.1, h.y0 - 0.02, 0.06), at(h.u1 + 0.1, h.y0 - 0.02, 0.06), 0.03, 0.12, timber, n)
  frameAround(M, L, { ...h, y0: h.y0 - 0.06 }, timber, [0.02])
}

/** A door leaf `w` wide and `top` tall standing on F's origin, its face to F's +z: boards on ledges, strap hinges and a ring. */
function doorLeaf(M, K, F, w, top) {
  const h = { y1: top }, boards = 5
  for (let i = 0; i < boards; i++) {
    const x0 = -w / 2 + (w * i) / boards + 0.003, x1 = -w / 2 + (w * (i + 1)) / boards - 0.003
    hewn(M.grain, K, F, [x0, 0.01, -0.05], [x1, h.y1 - 0.01, 0], WOOD(0.3 + i * 0.05, -0.1), 0.003)
  }
  for (const y of [Math.min(0.35, top * 0.2), top - Math.min(0.45, top * 0.25)]) {
    hewn(M.grain, K, F, [-w / 2 + 0.05, y - 0.08, 0], [w / 2 - 0.05, y + 0.08, 0.035], WOOD(0.4, -0.12), 0.003)
    iron(M.grain, K, F, [-w / 2 + 0.02, y - 0.03, 0.035], [w * 0.2, y + 0.03, 0.045])
    for (let k = 0; k < 4; k++) K.blob(M.grain, F, [-w / 2 + 0.08 + k * 0.15, y, 0.048], 0.012, 0.012, 0.006, IRON, { segs: 6, rows: 4 })
  }
  K.tube(M.grain, Array.from({ length: 13 }, (_, k) => { const q = (k / 12) * TAU; return put(F, w * 0.3 + Math.sin(q) * 0.07, Math.min(0.93, top / 2) + Math.cos(q) * 0.07, 0.06) }), Array(13).fill(0.009), IRON, { segs: 6, caps: false })
}

/** The cellar stair (design/38 Cellar): stone steps from its head down into the corner and on under the floor into the dark, and the board wall screening it from the room. */
function cellarWell(M, room, tint) {
  const c = room.cellar, L = { axis: c.axis, at: c.at, ix: c.ix, iz: c.iz }
  const o = pt(L, c.top, 0), w = c.w, len = c.u1 - c.u0, down = [c.nx, 0, c.nz]
  const F = { x: o.x, y: 0, z: o.z, ax: inward(L), ay: [0, 1, 0], az: down }
  const { rise: RISE, run: RUN } = CELLAR, STEPS = 12, end = STEPS * RUN, foot = -STEPS * RISE - 0.3
  // Lit from the room above, dark by the foot of the flight.
  const stone = (d) => rgb(0.08, 0.06, 0.42 * Math.max(0.08, 1 - d / end))
  const sUV = (p, n) => (n[0] ? [p[2] / STONE_M, p[1] / STONE_M] : n[1] ? [p[0] / STONE_M, p[2] / STONE_M] : [p[0] / STONE_M, p[1] / STONE_M])
  const face = (n, at) => M.stone.grid(1, 1, (i, j) => { const [x, y, d] = at(i, j); return { p: put(F, x, y, d), n, uv: [(x + d) / STONE_M, y / STONE_M], tint: stone(d) } }, null, 1)
  for (let k = 0; k < STEPS; k++) slab(M.stone, F, [0, -(k + 2) * RISE, k * RUN], [w, -(k + 1) * RISE, (k + 1) * RUN], stone(k * RUN), sUV)
  for (const [x, s] of [[0, 1], [w, -1]]) face(turn(F, s, 0, 0), (i, j) => [x, j ? 0 : foot, i * end])
  face(turn(F, 0, 0, 1), (i, j) => [i * w, j ? 0 : -RISE, 0])
  face(turn(F, 0, 0, -1), (i, j) => [i * w, j ? 0 : foot, end])
  face([0, -1, 0], (i, j) => [i * w, 0, len + j * (end - len)])
  const sc = c.screen, along = sc.axis === 'x', hw = PART / 2
  const top = (u) => (sc.y1 < 1e2 ? sc.y1 : (along ? townCeilingAt(room, u, sc.at) : townCeilingAt(room, sc.at, u)) + 0.1)
  for (const s of [-1, 1]) wallFace(M.wall, { axis: sc.axis, at: sc.at + s * hw, ix: along ? 0 : s, iz: along ? s : 0 }, 0, sc.lo, sc.hi, 0, top, [], [], tint)
  const head = -Math.sign(c.nx + c.nz)
  wallFace(M.wall, { axis: along ? 'z' : 'x', at: c.top, ix: along ? head : 0, iz: along ? 0 : head }, 0, sc.at - hw, sc.at + hw, 0, () => top(c.top), [], [], tint)
  if (c.cap) {
    const far = sc.at + Math.sign(sc.at - c.at) * hw, lo = Math.min(c.at, far), hi = Math.max(c.at, far)
    for (const [at, n] of [[c.cap.u, head], [c.cap.u - head * PART, -head]]) wallFace(M.wall, { axis: along ? 'z' : 'x', at, ix: along ? n : 0, iz: along ? 0 : n }, 0, lo, hi, 0, () => top(c.cap.u), [], [], tint)
  }
}

/** Firewood from p0 to p1, `sides` round and sawn flat at both ends. */
function firelog(m, p0, p1, r, tint, sides) {
  const w = norm(sub(p1, p0)), L = Math.hypot(...sub(p1, p0)), u = norm(cross(Math.abs(w[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], w)), v = cross(w, u)
  const dir = (i) => add(u.map((x) => x * Math.cos((i / sides) * TAU)), v, Math.sin((i / sides) * TAU))
  const base = m.count
  for (let i = 0; i <= sides; i++) for (const t of [0, 1]) m.v(add(t ? p1 : p0, dir(i), r), dir(i), [i / sides, (t * L) / WOOD_M], tint)
  for (let i = 0; i < sides; i++) m.quad(base + i * 2, base + i * 2 + 2, base + i * 2 + 3, base + i * 2 + 1)
  for (const [p, s] of [[p0, -1], [p1, 1]]) {
    const n = w.map((x) => x * s), mid = m.v(p, n, FLAT, tint), ring = Array.from({ length: sides }, (_, i) => m.v(add(p, dir(i), r), n, FLAT, tint))
    for (let i = 0; i < sides; i++) s > 0 ? m.tri(mid, ring[i], ring[(i + 1) % sides]) : m.tri(mid, ring[(i + 1) % sides], ring[i])
  }
}
/** The hearth: a stone chimney breast to the roof with a fire in its mouth, a beam for a mantel, a hearthstone, logs and a pot on a crane. */
function hearthAt(M, K, room, timber) {
  const h = room.hearth, L = { axis: h.axis, at: h.at, ix: h.ix, iz: h.iz }
  const n = inward(L), uax = h.axis === 'x' ? [1, 0, 0] : [0, 0, 1]
  const w = pt(L, h.u, 0)
  const F = { x: w.x, y: 0, z: w.z, ax: uax, ay: [0, 1, 0], az: n }
  const stone = rgb(0.08, 0.06, 0.48), sootT = SOOT
  const top = Math.max(...[-h.w / 2, h.w / 2].map((s) => { const p = pt(L, h.u + s, h.d); return townCeilingAt(room, p.x, p.z) })) + 0.2
  const mouth = { w: 1.1, h: 0.95, back: 0.18 }
  const sUV = (p, nn) => (nn[0] ? [p[2] / STONE_M, p[1] / STONE_M] : nn[1] ? [p[0] / STONE_M, p[2] / STONE_M] : [p[0] / STONE_M, p[1] / STONE_M])
  // Jambs, the breast over the mouth, the mouth's back and its sooty inside.
  slab(M.stone, F, [-h.w / 2, 0, 0], [-mouth.w / 2, top, h.d], stone, sUV)
  slab(M.stone, F, [mouth.w / 2, 0, 0], [h.w / 2, top, h.d], stone, sUV)
  slab(M.stone, F, [-mouth.w / 2, mouth.h, 0], [mouth.w / 2, top, h.d], stone, sUV)
  slab(M.stone, F, [-mouth.w / 2, 0, 0], [mouth.w / 2, mouth.h, mouth.back], sootT, sUV)
  slab(M.stone, F, [-mouth.w / 2 - 0.25, -0.02, h.d], [mouth.w / 2 + 0.25, 0.04, h.d + 0.45], rgb(0.08, 0.06, 0.4), sUV)
  hewn(M.grain, K, F, [-h.w / 2 - 0.08, mouth.h, h.d - 0.05], [h.w / 2 + 0.08, mouth.h + 0.2, h.d + 0.1], timber, 0.006)
  // Firedogs and logs.
  for (const s of [-1, 1]) {
    K.rod(M.grain, put(F, s * 0.25, 0, 0.62), put(F, s * 0.25, 0.22, 0.6), 0.015, 0.012, IRON, { flat: true })
    K.rod(M.grain, put(F, s * 0.25, 0.1, 0.25), put(F, s * 0.25, 0.1, 0.62), 0.012, 0.012, IRON, { flat: true })
  }
  for (const [a, b, y, n] of [[[-0.38, 0.32], [0.36, 0.45], 0.13, 6], [[-0.3, 0.48], [0.4, 0.3], 0.14, 4], [[-0.1, 0.36], [0.25, 0.42], 0.24, 6]]) firelog(M.grain, put(F, a[0], y, a[1]), put(F, b[0], y, b[1]), 0.052, rgb(0.07, 0.25, 0.14), n)
  // A crane from the jamb, a pot on its hook.
  const jx = -mouth.w / 2 + 0.04
  K.rod(M.grain, put(F, jx, 0.25, 0.4), put(F, jx, 0.9, 0.4), 0.014, 0.014, IRON, { flat: true })
  K.rod(M.grain, put(F, jx, 0.85, 0.4), put(F, 0.05, 0.85, 0.4), 0.012, 0.012, IRON, { flat: true })
  K.rod(M.grain, put(F, 0.05, 0.85, 0.4), put(F, 0.05, 0.62, 0.4), 0.006, 0.006, IRON, { flat: true })
  K.lathe(M.grain, frame(...put(F, 0.05, 0.42, 0.4)), [[0, 0], [0.09, 0.01], [0.13, 0.07], [0.12, 0.16], [0.105, 0.19], [0.11, 0.2], [0.095, 0.2], [0, 0.17]], IRON, { segs: 16, flat: true })
}

/** The upper floor: its boards over the slab, the slab's underside on joists, the stair hole's edges, the stair and its rails. */
function upperFloor(M, K, room, timber) {
  const U = room.U, st = room.stair, hole = st.hole, Mr = room.M
  const planks = rgb(0.075, 0.35, 0.3), under = rgb(0.075, 0.3, 0.22)
  const parts = [Mr]
  const rest = []
  for (const r of parts) {
    if (!(hole.x0 < r.x1 && r.x0 < hole.x1 && hole.z0 < r.z1 && r.z0 < hole.z1)) { rest.push(r); continue }
    if (hole.z0 > r.z0) rest.push({ ...r, z1: hole.z0 })
    if (hole.z1 < r.z1) rest.push({ ...r, z0: hole.z1 })
    const z0 = Math.max(r.z0, hole.z0), z1 = Math.min(r.z1, hole.z1)
    if (hole.x0 > r.x0) rest.push({ x0: r.x0, x1: hole.x0, z0, z1 })
    if (hole.x1 < r.x1) rest.push({ x0: hole.x1, x1: r.x1, z0, z1 })
  }
  for (const r of rest) {
    sheet(M.plank, r, () => U, 1, planks, FLOOR_M)
    sheet(M.plank, r, () => U - SLAB, -1, under, FLOOR_M)
  }
  // The hole's edges, where they are not the wall.
  const edge = (a, b, nrm) => M.plank.quad(...[[a, U - SLAB], [b, U - SLAB], [b, U], [a, U]].map(([p, y]) => M.plank.v([p[0], y, p[1]], nrm, [(p[0] + p[1]) / WOOD_M, y / WOOD_M], timber)))
  if (hole.x0 > Mr.x0 + 0.01) edge([hole.x0, hole.z0], [hole.x0, hole.z1], [1, 0, 0])
  if (hole.x1 < Mr.x1 - 0.01) edge([hole.x1, hole.z0], [hole.x1, hole.z1], [-1, 0, 0])
  if (hole.z0 > Mr.z0 + 0.01) edge([hole.x0, hole.z0], [hole.x1, hole.z0], [0, 0, 1])
  if (hole.z1 < Mr.z1 - 0.01) edge([hole.x0, hole.z1], [hole.x1, hole.z1], [0, 0, -1])
  // Joists across the short span, cut at the hole.
  const alongX = Mr.x1 - Mr.x0 < Mr.z1 - Mr.z0
  const [a0, a1] = alongX ? [Mr.z0, Mr.z1] : [Mr.x0, Mr.x1], [b0, b1] = alongX ? [Mr.x0, Mr.x1] : [Mr.z0, Mr.z1]
  for (let a = a0 + 0.35; a < a1 - 0.2; a += 0.7) {
    const runs = [[b0, b1]]
    const [h0, h1, c0, c1] = alongX ? [hole.x0, hole.x1, hole.z0, hole.z1] : [hole.z0, hole.z1, hole.x0, hole.x1]
    if (a > c0 - 0.06 && a < c1 + 0.06) { runs.length = 0; if (h0 > b0 + 0.1) runs.push([b0, h0]); if (h1 < b1 - 0.1) runs.push([h1, b1]) }
    for (const [s, e] of runs) {
      const p = alongX ? [s, U - SLAB - 0.09, a] : [a, U - SLAB - 0.09, s], q = alongX ? [e, U - SLAB - 0.09, a] : [a, U - SLAB - 0.09, e]
      beam(M.grain, p, q, 0.06, 0.09, timber)
    }
  }
  // The stair: slat treads on two strings, open between.
  const L = { axis: st.axis, at: st.at, ix: st.ix, iz: st.iz }
  st.treads.forEach((t, i) => {
    const u0 = st.u0 + st.dir * i * st.run, u1 = u0 + st.dir * st.run
    const lo = pt(L, u0 + st.dir * 0.012, 0.06), hi = pt(L, u1 - st.dir * 0.012, st.w - 0.06)
    const r = rect(lo.x, hi.x, lo.z, hi.z)
    hewn(M.grain, K, frame((r.x0 + r.x1) / 2, t.top, (r.z0 + r.z1) / 2), [-(r.x1 - r.x0) / 2, -0.045, -(r.z1 - r.z0) / 2], [(r.x1 - r.x0) / 2, 0, (r.z1 - r.z0) / 2], WOOD(0.45 + K.j(0.05), -0.04), 0.004)
  })
  const end = st.u0 + st.dir * st.n * st.run
  for (const d of [0.03, st.w - 0.03]) {
    const a = pt(L, st.u0 - st.dir * 0.02, d), b = pt(L, end, d)
    beam(M.grain, [a.x, 0.08, a.z], [b.x, U - SLAB * 0.5, b.z], 0.03, 0.11, timber)
  }
  // Rails round the hole: posts, a handrail and square balusters.
  for (const r of st.rails) {
    const longX = r.x1 - r.x0 > r.z1 - r.z0, cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2
    const a = longX ? [r.x0, cz] : [cx, r.z0], b = longX ? [r.x1, cz] : [cx, r.z1]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    beam(M.grain, [a[0], U + 0.97, a[1]], [b[0], U + 0.97, b[1]], 0.04, 0.03, timber)
    beam(M.grain, [a[0], U + 0.08, a[1]], [b[0], U + 0.08, b[1]], 0.035, 0.03, timber)
    for (const t of [0, 1]) beam(M.grain, [a[0] + (b[0] - a[0]) * t, U, a[1] + (b[1] - a[1]) * t], [a[0] + (b[0] - a[0]) * t, U + 1.05, a[1] + (b[1] - a[1]) * t], 0.045, 0.045, timber)
    const k = Math.floor(len / 0.14)
    for (let i = 1; i < k; i++) { const t = i / k; beam(M.grain, [a[0] + (b[0] - a[0]) * t, U + 0.11, a[1] + (b[1] - a[1]) * t], [a[0] + (b[0] - a[0]) * t, U + 0.94, a[1] + (b[1] - a[1]) * t], 0.015, 0.015, timber) }
  }
}

// --- the furniture -------------------------------------------------------------------

const F0 = (it, y = it.y) => frame(it.x, y, it.z, it.yaw)
/** A turned or hewn leg from (x, z) on the floor of `F` to height h. */
const leg = (M, K, F, x, z, h, r, tint, splay = 0) => hewn(M.grain, K, { ...F, x: put(F, x, 0, z)[0], y: F.y, z: put(F, x, 0, z)[2] }, [-r, 0, -r], [r, h, r], tint, 0.006 + splay)

function chairAt(M, K, F, it, { arms = false, cushion = null, tint }) {
  const T = it.top, hw = 0.21, hd = 0.2
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) leg(M, K, F, sx * (hw - 0.03), sz * (hd - 0.03), T - 0.04, 0.022, tint)
  hewn(M.grain, K, F, [-hw, T - 0.045, -hd], [hw, T, hd], tint, 0.005)
  for (const sx of [-1, 1]) hewn(M.grain, K, F, [sx * (hw - 0.03) - 0.024, T, -hd + 0.006], [sx * (hw - 0.03) + 0.024, T + 0.55, -hd + 0.05], tint, 0.006)
  for (const y of [T + 0.2, T + 0.42]) hewn(M.grain, K, F, [-hw + 0.03, y, -hd + 0.01], [hw - 0.03, y + 0.09, -hd + 0.04], tint, 0.005)
  for (const y of [0.12]) for (const sx of [-1, 1]) hewn(M.grain, K, F, [sx * (hw - 0.03) - 0.012, y, -hd + 0.03], [sx * (hw - 0.03) + 0.012, y + 0.03, hd - 0.03], tint, 0.004)
  if (arms) for (const sx of [-1, 1]) {
    hewn(M.grain, K, F, [sx * (hw - 0.03) - 0.02, T, hd - 0.05], [sx * (hw - 0.03) + 0.02, T + 0.22, hd - 0.01], tint, 0.005)
    hewn(M.grain, K, F, [sx * (hw - 0.03) - 0.03, T + 0.22, -hd + 0.02], [sx * (hw - 0.03) + 0.03, T + 0.25, hd + 0.02], tint, 0.005)
  }
  if (cushion !== null) K.box(M.linen, F, 0, T + 0.025, 0.01, hw - 0.02, 0.028, hd - 0.02, cushion, { round: 0.7, uvM: 0.3 })
}

function tableAt(M, K, it, tint) {
  const F = F0(it), T = it.top, hx = it.hx, hz = it.hz
  const n = Math.max(3, Math.round((2 * hz) / 0.24))
  for (let i = 0; i < n; i++) {
    const z0 = -hz + (2 * hz * i) / n + 0.004, z1 = -hz + (2 * hz * (i + 1)) / n - 0.004
    hewn(M.grain, K, F, [-hx + K.j(0.02), T - 0.05 + K.j(0.004), z0], [hx + K.j(0.02), T, z1], WOOD(it.hue + K.j(0.08), -0.02), 0.003)
  }
  for (const s of [-1, 1]) hewn(M.grain, K, F, [s * (hx - 0.2) - 0.04, T - 0.1, -hz + 0.04], [s * (hx - 0.2) + 0.04, T - 0.05, hz - 0.04], tint, 0.004)
  if (it.legs === 'trestle') {
    for (const s of [-1, 1]) {
      const x = s * (hx - 0.25)
      hewn(M.grain, K, F, [x - 0.04, 0.07, -hz * 0.22], [x + 0.04, T - 0.1, hz * 0.22], tint, 0.006)
      hewn(M.grain, K, F, [x - 0.05, 0, -hz * 0.8], [x + 0.05, 0.08, hz * 0.8], tint, 0.006)
    }
    hewn(M.grain, K, F, [-hx + 0.15, 0.3, -0.04], [hx - 0.15, 0.4, 0.04], tint, 0.005)
    for (const s of [-1, 1]) hewn(M.grain, K, F, [s * (hx - 0.13) - 0.015, 0.26, -0.025], [s * (hx - 0.13) + 0.015, 0.46, 0.025], tint, 0.01)
  } else {
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) leg(M, K, F, sx * (hx - 0.09), sz * (hz - 0.08), T - 0.05, 0.04, tint)
    for (const s of [-1, 1]) {
      hewn(M.grain, K, F, [-hx + 0.09, T - 0.16, s * (hz - 0.08) - 0.02], [hx - 0.09, T - 0.05, s * (hz - 0.08) + 0.02], tint, 0.004)
      hewn(M.grain, K, F, [s * (hx - 0.09) - 0.02, 0.1, -hz + 0.08], [s * (hx - 0.09) + 0.02, 0.15, hz - 0.08], tint, 0.004)
    }
  }
}

/** A plate standing on its rim against the wall behind it, or flat. */
function plateAt(M, K, F, r, tint, upright = false) {
  const prof = [[0, 0], [r * 0.55, 0], [r * 0.62, 0.006], [r, 0.016], [r * 1.02, 0.02], [r * 0.96, 0.02], [r * 0.8, 0.014], [r * 0.55, 0.009], [r * 0.3, 0.0065], [0, 0.006]]
  K.lathe(M.linen, upright ? tip(tip({ ...F, y: F.y + r }, 'ay', Math.PI), 'ax', -Math.PI / 2 + 0.25) : F, prof, tint, { segs: 18, flat: true })
}
const mugAt = (M, K, F, tint) => {
  K.lathe(M.grain, F, [[0, 0], [0.042, 0], [0.044, 0.004], [0.04, 0.1], [0.037, 0.1], [0.035, 0.012], [0, 0.012]], tint, { segs: 12, uvM: 0.2 })
  for (const y of [0.02, 0.085]) K.lathe(M.grain, F, [[0.043, y - 0.005], [0.046, y - 0.004], [0.046, y + 0.004], [0.043, y + 0.005]], IRON, { segs: 12, flat: true })
  K.tube(M.grain, [put(F, 0.04, 0.08, 0), put(F, 0.075, 0.075, 0), put(F, 0.075, 0.03, 0), put(F, 0.04, 0.025, 0)], [0.008, 0.008, 0.008, 0.008], tint, { segs: 6 })
}
const bowlAt = (M, K, F, r, tint) => K.lathe(M.grain, F, [[0, 0], [r * 0.5, 0], [r * 0.85, r * 0.25], [r, r * 0.6], [r * 0.95, r * 0.62], [r * 0.8, r * 0.3], [r * 0.4, r * 0.1], [0, r * 0.1]], tint, { segs: 16, uvM: 0.2 })
const jugAt = (M, K, F, tint) => {
  K.lathe(M.linen, F, [[0, 0], [0.05, 0], [0.07, 0.05], [0.072, 0.11], [0.05, 0.18], [0.04, 0.21], [0.046, 0.235], [0.04, 0.235], [0.033, 0.2, 0.55], [0.05, 0.14, 0.3], [0.052, 0.06, 0.18], [0, 0.03, 0.15]], tint, { segs: 14, flat: true, rough: 0.03 })
  K.tube(M.linen, [put(F, -0.045, 0.2, 0), put(F, -0.1, 0.19, 0), put(F, -0.1, 0.1, 0), put(F, -0.068, 0.07, 0)], [0.01, 0.01, 0.01, 0.01], tint, { segs: 6, flat: true })
}
const crockAt = (M, K, F, tint) => {
  K.lathe(M.linen, F, [[0, 0], [0.08, 0], [0.1, 0.06], [0.1, 0.15], [0.085, 0.19], [0.088, 0.2], [0, 0.2]], tint, { segs: 16, flat: true, rough: 0.02 })
  K.lathe(M.linen, frame(F.x, F.y + 0.2, F.z), [[0, 0.025], [0.02, 0.025], [0.02, 0.012], [0.09, 0.006], [0.09, 0], [0, 0]], tint, { segs: 14, flat: true })
}
const jarAt = (M, K, F, tint) => {
  K.lathe(M.linen, F, [[0, 0], [0.045, 0], [0.06, 0.06], [0.055, 0.13], [0.04, 0.15], [0.042, 0.17], [0, 0.17]], tint, { segs: 12, flat: true, rough: 0.03 })
  K.lathe(M.linen, frame(F.x, F.y + 0.155, F.z), [[0.052, 0], [0.05, 0.012], [0.03, 0.025], [0, 0.028]], CREAM, { segs: 12, flat: true, rough: 0.12 })
  K.lathe(M.linen, frame(F.x, F.y + 0.15, F.z), [[0.044, 0], [0.047, 0.006], [0.044, 0.012]], CORD, { segs: 10, flat: true })
}
const BREW = [rgb(0.33, 0.6, 0.35), rgb(0.6, 0.55, 0.38), rgb(0.98, 0.65, 0.38), rgb(0.1, 0.75, 0.45), rgb(0.78, 0.45, 0.35)]
/** A round-bellied bottle of something coloured, corked. */
const potionAt = (M, K, F, h) => {
  const s = 0.8 + (h * 13 % 1) * 0.5
  K.lathe(M.linen, F, [[0, 0], [0.03 * s, 0], [0.042 * s, 0.03 * s], [0.04 * s, 0.06 * s], [0.014, 0.085 * s], [0.012, 0.085 * s + 0.04], [0.016, 0.085 * s + 0.045], [0, 0.085 * s + 0.045]], BREW[Math.floor(h * BREW.length) % BREW.length], { segs: 10, flat: true })
  K.lathe(M.linen, frame(F.x, F.y + 0.085 * s + 0.04, F.z), [[0.011, 0], [0.012, 0.02], [0, 0.022]], CORD, { segs: 8, flat: true })
}
const potAt = (M, K, F) => {
  K.lathe(M.grain, F, [[0, 0.02], [0.08, 0.025], [0.11, 0.08], [0.105, 0.14], [0.095, 0.15], [0.1, 0.16], [0.09, 0.16], [0, 0.13]], IRON, { segs: 14, flat: true })
  for (const s of [-1, 1]) K.rod(M.grain, put(F, s * 0.05, 0, 0.05), put(F, s * 0.06, 0.04, 0.06), 0.008, 0.01, IRON, { flat: true })
  K.tube(M.grain, Array.from({ length: 9 }, (_, k) => put(F, -0.1 + (0.2 * k) / 8, 0.16 + Math.sin((k / 8) * Math.PI) * 0.09, 0)), Array(9).fill(0.004), IRON, { segs: 5 })
}
const boxAt = (M, K, F, h, tint) => {
  hewn(M.grain, K, F, [-0.09, 0, -0.06], [0.09, 0.08, 0.06], tint, 0.004)
  hewn(M.grain, K, F, [-0.095, 0.08, -0.065], [0.095, 0.1, 0.065], DARKWOOD(h), 0.004)
  iron(M.grain, K, F, [-0.012, 0.06, 0.06], [0.012, 0.095, 0.068])
}
const scrollAt = (M, K, F, len) => {
  K.tube(M.linen, [put(F, -len / 2, 0.022, 0), put(F, len / 2, 0.022, 0)], [0.022, 0.022], CREAM, { segs: 10, flat: true })
  for (const s of [-1, 1]) K.lathe(M.grain, tip({ ...F, ...Object.fromEntries(['x', 'y', 'z'].map((k, i) => [k, put(F, s * (len / 2 + 0.005), 0.022, 0)[i]])) }, 'az', (s * Math.PI) / 2), [[0, 0], [0.012, 0], [0.012, 0.02], [0, 0.025]], WOOD(0.2, -0.1), { segs: 8, flat: true })
}
const inkpotAt = (M, K, F) => {
  K.lathe(M.linen, F, [[0, 0], [0.03, 0], [0.032, 0.03], [0.015, 0.045], [0.015, 0.05], [0, 0.05]], INK, { segs: 10, flat: true })
  K.leaf(M.linen, put(F, 0, 0.045, 0), norm([0.4, 1, 0.2]), 0.22, 0.012, [1, 0, -0.4], CREAM)
}
function booksStack(M, K, F, n, rng) {
  let y = 0
  for (let i = 0; i < n; i++) {
    const t = 0.03 + rng() * 0.03, h = 0.2 + rng() * 0.06, d = 0.15 + rng() * 0.04
    bookAt(M, tip(tip({ ...F, y: F.y + y + t / 2 }, 'ay', K.j(0.3)), 'az', Math.PI / 2), t, h, d, binding(rng))
    y += t
  }
}
/** Upright books from x0 to x1 along `F`'s x, spines out (+z). */
function bookRow(M, K, F, x0, x1, rng) {
  for (let x = x0; x < x1 - 0.03;) {
    const t = 0.025 + rng() * 0.035, h = 0.19 + rng() * 0.08, d = 0.14 + rng() * 0.04
    if (x + t > x1) break
    if (rng() < 0.08) { x += t * 2; continue }
    const lean = x + t > x1 - 0.06 && rng() < 0.4 ? 0.25 : 0
    bookAt(M, tip({ ...F, ...xyz(put(F, x + t / 2, h / 2, -0.01)) }, 'az', -lean), t, h, d, binding(rng))
    x += t + 0.002
  }
}
const xyz = (p) => ({ x: p[0], y: p[1], z: p[2] })

/** One thing off a shelf's load, at `F` on the board. */
function loadAt(M, K, F, l, room, rng) {
  const f = tip(F, 'ay', l.yaw)
  switch (l.kind) {
    case 'plate': return plateAt(M, K, { ...F, ...xyz(put(F, 0, 0, -0.06)) }, 0.1, rng() < room.tin ? PEWTER : TURNED(l.hue), true)
    case 'mug': return mugAt(M, K, f, TURNED(l.hue))
    case 'jug': return jugAt(M, K, f, CLAY(l.hue))
    case 'bowl': return bowlAt(M, K, f, 0.08, TURNED(l.hue))
    case 'pot': return potAt(M, K, f)
    case 'jar': return jarAt(M, K, f, CLAY(l.hue))
    case 'potion': return potionAt(M, K, f, l.hue)
    case 'crock': return crockAt(M, K, f, CLAY(l.hue * 0.5))
    case 'books': return bookRow(M, K, F, -0.08, 0.1, rng)
    case 'scroll': return scrollAt(M, K, tip(F, 'ay', 0.1), 0.2)
    case 'inkpot': return inkpotAt(M, K, f)
    case 'box': return boxAt(M, K, f, l.hue, WOOD(l.hue))
    case 'gap': case 'candle': return
    default: throw new Error(`TownInteriorView: no shelf load ${l.kind}`)
  }
}

const ITEMS = {
  table(it, M, K) { tableAt(M, K, it, WOOD(it.hue, -0.04)) },
  chair(it, M, K, room) { chairAt(M, K, F0(it), it, { arms: !!it.arms, cushion: it.cushion === null ? null : cloth(room, it.cushion), tint: WOOD(it.hue, -0.05) }) },
  bench(it, M, K) {
    const F = F0(it), T = it.top, tint = WOOD(it.hue, -0.05)
    hewn(M.grain, K, F, [-it.hx, T - 0.05, -it.hz], [it.hx, T, it.hz], tint, 0.004)
    for (const s of [-1, 1]) hewn(M.grain, K, F, [s * (it.hx - 0.15) - 0.03, 0, -it.hz + 0.02], [s * (it.hx - 0.15) + 0.03, T - 0.05, it.hz - 0.02], tint, 0.008)
    hewn(M.grain, K, F, [-it.hx + 0.15, 0.18, -0.03], [it.hx - 0.15, 0.25, 0.03], tint, 0.004)
  },
  plate(it, M, K, room) { plateAt(M, K, F0(it), 0.11, it.hue < room.tin ? PEWTER : TURNED(it.hue)) },
  mug(it, M, K) { mugAt(M, K, F0(it), TURNED(it.hue)) },
  bowl(it, M, K) { bowlAt(M, K, F0(it), 0.09, TURNED(it.hue)) },
  jug(it, M, K) { jugAt(M, K, F0(it), CLAY(it.hue)) },
  loaf(it, M, K) { K.blob(M.linen, F0(it), [0, 0.045, 0], 0.11, 0.055, 0.07, rgb(0.08, 0.5, 0.36), { rough: 0.05 }) },
  fruitbowl(it, M, K, room, rng) {
    const F = F0(it)
    K.lathe(M.grain, F, [[0, 0], [0.08, 0], [0.12, 0.03], [0.17, 0.08], [0.16, 0.085], [0.11, 0.04], [0, 0.03]], TURNED(it.hue), { segs: 18, uvM: 0.25 })
    for (let k = 0; k < it.n; k++) {
      const q = (k / it.n) * TAU + K.j(0.3), r = k < 5 ? 0.07 : 0.02, y = k < 5 ? 0.07 : 0.12
      const pear = rng() < 0.25
      K.blob(M.linen, F, [Math.cos(q) * r, y, Math.sin(q) * r], 0.036, pear ? 0.05 : 0.034, 0.036, FRUIT[Math.floor(rng() * FRUIT.length)], { segs: 10, rows: 6 })
    }
  },
  candle(it, M, K) {
    if (it.holder === 'stick') {
      const F = F0(it)
      K.lathe(M.grain, F, [[0, 0], [0.06, 0], [0.065, 0.01], [0.02, 0.025], [0.012, 0.03], [0.012, 0.17], [0.045, 0.18], [0.048, 0.19], [0, 0.19]], IRON, { segs: 12, flat: true })
      candleOn(M, K, it.x, it.y + 0.188, it.z, it.h, IRON)
    } else candleOn(M, K, it.x, it.y, it.z, it.h, CLAY(0.4))
  },
  rug(it, M, K, room) {
    const n = it.stripes * 2 + 1, base = cloth(room, it.hue), band = cloth(room, (it.hue + 0.37) % 1)
    for (let i = 0; i < n; i++) {
      const x0 = -it.hx + (2 * it.hx * i) / n, x1 = -it.hx + (2 * it.hx * (i + 1)) / n
      const r = { x0: it.x + x0, x1: it.x + x1, z0: it.z - it.hz, z1: it.z + it.hz }
      sheet(M.linen, r, () => it.y + 0.015, 1, i % 2 ? band : base, 0.5)
    }
  },
  dresser(it, M, K, room) {
    const F = F0(it), tint = WOOD(it.hue, -0.05), hx = it.hx, hz = it.hz, T = it.top
    hewn(M.grain, K, F, [-hx, 0, -hz], [hx, 0.85, hz], tint, 0.004)
    hewn(M.grain, K, F, [-hx - 0.02, 0.85, -hz - 0.01], [hx + 0.02, 0.89, hz + 0.03], tint, 0.004)
    for (const s of [-1, 1]) {
      hewn(M.grain, K, F, [s < 0 ? -hx + 0.04 : 0.01, 0.08, hz], [s < 0 ? -0.01 : hx - 0.04, 0.78, hz + 0.02], WOOD(it.hue, -0.08), 0.003)
      for (const y of [0.2, 0.66]) iron(M.grain, K, F, [s * 0.02 + (s < 0 ? -hx + 0.04 : 0.01), y - 0.015, hz + 0.02], [s < 0 ? -hx * 0.4 : hx - 0.04, y + 0.015, hz + 0.028])
    }
    hewn(M.grain, K, F, [-hx, 0.89, -hz], [hx, T, -hz + 0.03], tint, 0.004)
    for (const s of [-1, 1]) hewn(M.grain, K, F, [s * hx - 0.02, 0.89, -hz], [s * hx + 0.02, T, -hz + 0.2], tint, 0.004)
    hewn(M.grain, K, F, [-hx - 0.03, T - 0.04, -hz], [hx + 0.03, T, -hz + 0.24], tint, 0.004)
    for (const y of [1.2, 1.52]) {
      if (y > T - 0.25) continue
      hewn(M.grain, K, F, [-hx + 0.02, y - 0.025, -hz + 0.03], [hx - 0.02, y, -hz + 0.19], tint, 0.003)
      hewn(M.grain, K, F, [-hx + 0.02, y + 0.03, -hz + 0.17], [hx - 0.02, y + 0.05, -hz + 0.19], tint, 0.003)
      for (let x = -hx + 0.14; x < hx - 0.1; x += 0.24) plateAt(M, K, { ...F, ...xyz(put(F, x, y, -hz + 0.1)) }, 0.1, it.load === 'plates' && ((x * 7) % 2 > 1 || (x * 3.7) % 1 > room.tin) ? TURNED(it.hue) : PEWTER, true)
    }
  },
  shelf(it, M, K, room, rng) {
    const F = F0(it), tint = WOOD(0.3, -0.06)
    hewn(M.grain, K, F, [-it.hx, -0.035, -it.hz], [it.hx, 0, it.hz], tint, 0.003)
    for (const s of [-1, 1]) {
      const x = s * (it.hx - 0.12)
      K.rod(M.grain, put(F, x, -0.035, -it.hz + 0.01), put(F, x, -0.035, it.hz - 0.03), 0.009, 0.009, IRON, { flat: true })
      K.rod(M.grain, put(F, x, -0.22, -it.hz + 0.01), put(F, x, -0.035, it.hz - 0.04), 0.008, 0.008, IRON, { flat: true })
    }
    for (const l of it.load) loadAt(M, K, { ...F, ...xyz(put(F, l.u, 0, 0.01)) }, l, room, rng)
  },
  worktable(it, M, K) {
    const F = F0(it), tint = WOOD(it.hue, -0.03), T = it.top
    hewn(M.grain, K, F, [-it.hx, T - 0.08, -it.hz], [it.hx, T, it.hz], tint, 0.004)
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) leg(M, K, F, sx * (it.hx - 0.08), sz * (it.hz - 0.07), T - 0.08, 0.045, tint)
    hewn(M.grain, K, F, [-it.hx + 0.04, 0.16, -it.hz + 0.04], [it.hx - 0.04, 0.2, it.hz - 0.04], tint, 0.004)
  },
  crock(it, M, K) { crockAt(M, K, F0(it), CLAY(it.hue * 0.5)) },
  cabbage(it, M, K) {
    const F = F0(it)
    for (let k = 0; k < 5; k++) K.blob(M.linen, tip(F, 'ax', K.j(0.4)), [K.j(0.01), 0.06 + k * 0.004, K.j(0.01)], 0.08 - k * 0.012, 0.06 - k * 0.006, 0.08 - k * 0.012, rgb(0.25 + k * 0.01, 0.45, 0.32 + k * 0.05), { segs: 12, rows: 6, rough: 0.08 })
  },
  board(it, M, K) {
    const F = F0(it)
    hewn(M.grain, K, F, [-0.17, 0, -0.11], [0.17, 0.025, 0.11], WOOD(0.7), 0.003)
    K.blob(M.linen, F, [0.05, 0.04, 0], 0.06, 0.03, 0.04, rgb(0.1, 0.5, 0.4), { rough: 0.05 })
  },
  jar(it, M, K) { jarAt(M, K, F0(it), CLAY(it.hue)) },
  potion(it, M, K) { potionAt(M, K, F0(it), it.hue) },
  // Closed toward the room (+Z), open behind to a shelf for the keeper.
  counter(it, M, K) {
    const F = F0(it), tint = WOOD(it.hue, -0.04), T = it.top, hx = it.hx, hz = it.hz
    hewn(M.grain, K, F, [-hx - 0.03, T - 0.05, -hz - 0.03], [hx + 0.03, T, hz + 0.04], tint, 0.004)
    const n = Math.round((2 * hx) / 0.2)
    for (let i = 0; i < n; i++) hewn(M.grain, K, F, [-hx + (2 * hx * i) / n + 0.003, 0, hz - 0.03], [-hx + (2 * hx * (i + 1)) / n - 0.003, T - 0.05, hz], WOOD(it.hue + K.j(0.08), -0.06), 0.003)
    for (const s of [-1, 1]) hewn(M.grain, K, F, [s * hx - 0.03, 0, -hz], [s * hx + 0.03, T - 0.05, hz], tint, 0.004)
    hewn(M.grain, K, F, [-hx + 0.03, 0.3, -hz + 0.02], [hx - 0.03, 0.33, hz - 0.03], tint, 0.003)
  },
  barrel(it, M, K) {
    const F = F0(it), r = it.r, h = it.top
    K.lathe(M.grain, F, [[0, 0.01], [r * 0.82, 0.01], [r * 0.84, 0], [r * 0.95, h * 0.25], [r, h * 0.5], [r * 0.95, h * 0.75], [r * 0.84, h], [r * 0.8, h], [r * 0.79, h - 0.02], [0, h - 0.02]], WOOD(it.hue, -0.02), { segs: 22, uvM: 0.3, lobes: [18, 0.015] })
    for (const t of [0.12, 0.32, 0.68, 0.88]) {
      const y = h * t, rr = r * (1 - 0.18 * Math.abs(t - 0.5) * 2 * Math.abs(t - 0.5) * 2) + 0.004
      K.lathe(M.grain, F, [[rr, y - 0.02], [rr + 0.004, y - 0.018], [rr + 0.004, y + 0.018], [rr, y + 0.02]], IRON, { segs: 22, flat: true })
    }
  },
  sack(it, M, K) { sackAt(M, K, K.crook(F0(it), 0.1), it.r, it.top, BURLAP(it.hue)) },
  stool(it, M, K) {
    const F = F0(it), T = it.top, tint = WOOD(it.hue, -0.04), h = it.r
    hewn(M.grain, K, F, [-h, T - 0.04, -h * 0.8], [h, T, h * 0.8], tint, 0.005)
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) hewn(M.grain, K, tip({ ...F, ...xyz(put(F, sx * (h - 0.05), 0, sz * (h * 0.8 - 0.05))) }, 'az', sx * 0.08), [-0.018, 0, -0.018], [0.018, T - 0.04, 0.018], tint, 0.005)
    for (const s of [-1, 1]) hewn(M.grain, K, F, [-h + 0.05, 0.12, s * (h * 0.8 - 0.05) - 0.01], [h - 0.05, 0.15, s * (h * 0.8 - 0.05) + 0.01], tint, 0.004)
  },
  armchair(it, M, K, room) {
    const F = F0(it), tint = WOOD(it.hue, -0.07), T = it.top, w = 0.34, d = 0.32
    hewn(M.grain, K, F, [-w, 0, -d], [w, T - 0.04, d], tint, 0.005)
    for (const s of [-1, 1]) hewn(M.grain, K, F, [s * w - 0.04, 0, -d], [s * w + 0.04, T + 0.25, d + 0.02], tint, 0.005)
    hewn(M.grain, K, F, [-w - 0.04, 0, -d - 0.06], [w + 0.04, T + 0.75, -d + 0.02], tint, 0.005)
    hewn(M.grain, K, F, [-w - 0.08, T + 0.73, -d - 0.08], [w + 0.08, T + 0.8, -d + 0.04], tint, 0.005)
    K.box(M.linen, F, 0, T + 0.02, 0.02, w - 0.05, 0.06, d - 0.03, cloth(room, it.hue), { round: 0.7, uvM: 0.3 })
    K.box(M.linen, tip({ ...F, ...xyz(put(F, 0, T + 0.35, -d + 0.08)) }, 'ax', -0.15), 0, 0, 0, w - 0.08, 0.24, 0.05, cloth(room, it.hue), { round: 0.7, uvM: 0.3 })
  },
  rocker(it, M, K, room) {
    const F = F0(it), tint = WOOD(it.hue, -0.04), T = it.top
    for (const s of [-1, 1]) K.tube(M.grain, Array.from({ length: 9 }, (_, k) => { const t = -0.45 + (0.9 * k) / 8; return put(F, s * 0.22, 0.02 + 0.25 * t * t, t) }), Array(9).fill(0.02), tint, { segs: 6 })
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) K.rod(M.grain, put(F, sx * 0.22, 0.03 + 0.25 * 0.04, sz * 0.2), put(F, sx * 0.21, T, sz * 0.2), 0.018, 0.016, tint)
    hewn(M.grain, K, F, [-0.24, T - 0.04, -0.22], [0.24, T, 0.24], tint, 0.005)
    const back = tip({ ...F, ...xyz(put(F, 0, T, -0.21)) }, 'ax', -0.25)
    for (const s of [-1, 1]) K.rod(M.grain, put(back, s * 0.21, 0, 0), put(back, s * 0.2, 0.62, 0), 0.02, 0.017, tint)
    hewn(M.grain, K, back, [-0.24, 0.56, -0.03], [0.24, 0.66, 0.02], tint, 0.005)
    for (let k = -2; k <= 2; k++) K.rod(M.grain, put(back, k * 0.07, 0.05, 0), put(back, k * 0.07, 0.57, 0), 0.009, 0.009, tint)
    for (const s of [-1, 1]) hewn(M.grain, K, F, [s * 0.22 - 0.03, T + 0.22, -0.2], [s * 0.22 + 0.03, T + 0.25, 0.22], tint, 0.005)
    for (const s of [-1, 1]) K.rod(M.grain, put(F, s * 0.22, T, 0.2), put(F, s * 0.22, T + 0.22, 0.2), 0.014, 0.014, tint)
    K.box(M.linen, F, 0, T + 0.02, 0.01, 0.2, 0.025, 0.2, cloth(room, it.hue * 0.7), { round: 0.7, uvM: 0.3 })
  },
  bookcase(it, M, K, room, rng) {
    const F = F0(it), tint = WOOD(it.hue, -0.08), hx = it.hx, hz = it.hz, T = it.top
    for (const s of [-1, 1]) hewn(M.grain, K, F, [s * hx - 0.025, 0, -hz], [s * hx + 0.025, T, hz], tint, 0.003)
    hewn(M.grain, K, F, [-hx, 0, -hz], [hx, T, -hz + 0.02], tint, 0.003)
    hewn(M.grain, K, F, [-hx - 0.04, T - 0.05, -hz], [hx + 0.04, T, hz + 0.03], tint, 0.003)
    const shelves = 5
    for (let i = 0; i < shelves; i++) {
      const y = 0.06 + (i * (T - 0.15)) / shelves
      hewn(M.grain, K, F, [-hx + 0.025, y, -hz + 0.02], [hx - 0.025, y + 0.03, hz], tint, 0.002)
      if (i > 0 || rng() < 0.5) bookRow(M, K, { ...F, ...xyz(put(F, 0, y + 0.03, hz - 0.01)) }, -hx + 0.04, hx - 0.04, rng)
    }
  },
  chest(it, M, K, room, rng) {
    const F = F0(it), tint = WOOD(it.hue, -0.06), hx = it.hx, hz = it.hz, T = it.top
    hewn(M.grain, K, F, [-hx, 0.03, -hz], [hx, T - 0.07, hz], tint, 0.004)
    hewn(M.grain, K, F, [-hx - 0.015, T - 0.07, -hz - 0.015], [hx + 0.015, T, hz + 0.015], tint, 0.004)
    for (const x of [-hx * 0.6, 0, hx * 0.6]) {
      if (x === 0) continue
      iron(M.grain, K, F, [x - 0.025, 0.03, hz], [x + 0.025, T, hz + 0.022])
      iron(M.grain, K, F, [x - 0.025, T, -hz - 0.016], [x + 0.025, T + 0.006, hz + 0.022])
    }
    for (const s of [-1, 1]) iron(M.grain, K, F, [s * hx - 0.02, 0, -hz], [s * hx + 0.02, 0.03, hz])
    iron(M.grain, K, F, [-0.03, T - 0.16, hz + 0.016], [0.03, T - 0.02, hz + 0.03])
    if (it.scrolls) for (let k = 0; k < 3; k++) scrollAt(M, K, tip({ ...F, ...xyz(put(F, K.j(hx * 0.4), T + 0.006 + k * 0.03, K.j(hz * 0.4))) }, 'ay', K.j(0.4)), 0.3 + rng() * 0.1)
  },
  desk(it, M, K) {
    const F = F0(it), tint = WOOD(it.hue, -0.06), T = it.top
    hewn(M.grain, K, F, [-it.hx, T - 0.045, -it.hz], [it.hx, T, it.hz], tint, 0.003)
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) leg(M, K, F, sx * (it.hx - 0.05), sz * (it.hz - 0.05), T - 0.045, 0.03, tint)
    hewn(M.grain, K, F, [-it.hx * 0.5, T - 0.15, it.hz - 0.06], [it.hx * 0.5, T - 0.045, it.hz - 0.03], WOOD(it.hue, -0.1), 0.003)
    K.blob(M.grain, F, [0, T - 0.1, it.hz - 0.02], 0.015, 0.015, 0.01, IRON, { segs: 6, rows: 4 })
    hewn(M.grain, K, F, [-it.hx, T, -it.hz], [it.hx, T + 0.18, -it.hz + 0.03], tint, 0.003)
    hewn(M.grain, K, F, [-it.hx, T + 0.1, -it.hz], [it.hx, T + 0.12, -it.hz + 0.12], tint, 0.003)
  },
  parchment(it, M) {
    const F = F0(it), w = 0.11, h = 0.15
    M.linen.grid(4, 1, (i, j) => { const x = -w + (2 * w * i) / 4; return { p: put(F, x, 0.002 + 0.01 * Math.max(0, Math.abs(x / w) - 0.6), j ? h : -h), n: [0, 1, 0], uv: FLAT } }, rgb(0.11, 0.35, 0.78), 1)
  },
  scroll(it, M, K) { scrollAt(M, K, F0(it, it.y), it.len) },
  inkpot(it, M, K) { inkpotAt(M, K, F0(it)) },
  books(it, M, K, room, rng) { booksStack(M, K, F0(it), it.n, rng) },
  scrollbin(it, M, K, room, rng) {
    const F = F0(it), r = it.r, h = it.top
    K.lathe(M.grain, F, [[0, 0.01], [r * 0.9, 0.01], [r, 0], [r * 1.02, h], [r * 0.95, h], [r * 0.88, 0.03], [0, 0.03]], WICKER, { segs: 18, lobes: [14, 0.03], uvM: 0.15 })
    for (let k = 0; k < 7; k++) {
      const q = (k / 7) * TAU, rr = r * 0.5 * (k % 2), top = h + 0.05 + rng() * 0.12
      K.tube(M.linen, [put(F, Math.cos(q) * rr, 0.05, Math.sin(q) * rr), put(F, Math.cos(q) * rr * 1.3, top, Math.sin(q) * rr * 1.3)], [0.022, 0.022], CREAM, { segs: 8, flat: true })
    }
  },
  crate(it, M, K) {
    const F = F0(it), s = it.s / 2
    for (let k = 0; k < it.stack; k++) {
      const G = tip({ ...F, y: F.y + k * it.s }, 'ay', k * 0.3 + K.j(0.1))
      hewn(M.grain, K, G, [-s + 0.02, 0.01, -s + 0.02], [s - 0.02, it.s - 0.01, s - 0.02], WOOD(it.hue, -0.12), 0.004)
      for (let i = 0; i < 3; i++) for (const side of [-1, 1]) {
        const y0 = 0.02 + (i * (it.s - 0.04)) / 3, y1 = y0 + (it.s - 0.04) / 3 - 0.02
        hewn(M.grain, K, G, [-s, y0, side * s - 0.012], [s, y1, side * s + 0.012], WOOD(it.hue + i * 0.1, -0.02), 0.003)
        hewn(M.grain, K, G, [side * s - 0.012, y0, -s], [side * s + 0.012, y1, s], WOOD(it.hue + i * 0.1, -0.02), 0.003)
      }
      hewn(M.grain, K, G, [-s, it.s - 0.025, -s], [s, it.s, s], WOOD(it.hue, -0.04), 0.003)
    }
  },
  sidetable(it, M, K) {
    const F = F0(it), tint = WOOD(it.hue, -0.05), T = it.top, h = it.hx
    hewn(M.grain, K, F, [-h, T - 0.035, -h], [h, T, h], tint, 0.004)
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) leg(M, K, F, sx * (h - 0.05), sz * (h - 0.05), T - 0.035, 0.022, tint)
    hewn(M.grain, K, F, [-h + 0.03, 0.14, -h + 0.03], [h - 0.03, 0.165, h - 0.03], tint, 0.003)
  },
  basket(it, M, K, room, rng) {
    const F = F0(it), r = it.r, h = it.top
    K.lathe(M.grain, F, [[0, 0.01], [r * 0.8, 0.01], [r * 0.85, 0], [r, h], [r * 0.94, h], [r * 0.78, 0.03], [0, 0.03]], WICKER, { segs: 18, lobes: [12, 0.025], uvM: 0.15 })
    K.tube(M.grain, Array.from({ length: 7 }, (_, k) => { const q = (k / 6) * Math.PI; return put(F, Math.cos(q) * r * 0.92, h + Math.sin(q) * r * 0.9, 0) }), Array(7).fill(0.012), WICKER, { segs: 5 })
    for (let k = 0; k < 5; k++) {
      const q = (k / 5) * TAU + K.j(0.4), c = [Math.cos(q) * r * 0.45, h - 0.03, Math.sin(q) * r * 0.45]
      if (it.load === 'apples') K.blob(M.linen, F, c, 0.04, 0.038, 0.04, FRUIT[Math.floor(rng() * FRUIT.length)], { segs: 10, rows: 6 })
      else if (it.load === 'wool') K.blob(M.linen, F, c, 0.06, 0.055, 0.06, cloth(room, (it.hue + k * 0.13) % 1), { rough: 0.06 })
      else if (k < 3) K.box(M.linen, tip({ ...F, ...xyz(put(F, 0, h - 0.04 + k * 0.035, 0)) }, 'ay', K.j(0.5)), 0, 0, 0, r * 0.6, 0.016, r * 0.45, k === 1 ? cloth(room, it.hue) : CREAM, { round: 0.6, uvM: 0.3 })
    }
  },
  logpile(it, M, K) {
    const F = F0(it), r = 0.055, bark = rgb(0.07, 0.3, 0.2 + it.hue * 0.06)
    for (const [row, n] of [[0, 3], [1, 2], [2, 1]]) for (let i = 0; i < n; i++) {
      const z = (i - (n - 1) / 2) * 2 * r + K.j(0.01), y = r + row * r * 1.75, l = it.hx - K.j(0.06) - 0.03
      K.tube(M.grain, [put(F, -l, y, z), put(F, l, y + K.j(0.01), z + K.j(0.02))], [r + K.j(0.01), r + K.j(0.01)], bark, { segs: 8 })
    }
  },
  pegrail(it, M, K, room) {
    const F = F0(it), tint = WOOD(it.hue, -0.06)
    hewn(M.grain, K, F, [-it.hx, -0.05, 0], [it.hx, 0.05, 0.025], tint, 0.002)
    it.hang.forEach((h, i) => {
      const x = -it.hx + 0.125 + i * 0.25
      K.rod(M.grain, put(F, x, 0, 0.025), put(F, x, 0.03, 0.11), 0.012, 0.01, tint)
      if (h === 'cloak') K.blob(M.linen, F, [x, -0.42, 0.07], 0.16, 0.45, 0.06, cloth(room, (it.hue + i * 0.29) % 1), { rough: 0.05 })
      else if (h === 'bag') {
        K.blob(M.linen, F, [x, -0.25, 0.08], 0.1, 0.13, 0.07, BURLAP((it.hue + i * 0.17) % 1), { rough: 0.06 })
        K.tube(M.linen, [put(F, x - 0.07, -0.15, 0.08), put(F, x, 0.03, 0.1), put(F, x + 0.07, -0.15, 0.08)], [0.008, 0.008, 0.008], BURLAP(it.hue), { segs: 5 })
      }
    })
  },
  bed(it, M, K, room, rng) {
    const F = F0(it), tint = WOOD(it.hue, -0.07), hw = it.wid / 2, hl = it.len / 2, T = it.top
    const post = it.posts ? 1.7 : 0.95
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) hewn(M.grain, K, F, [sx * hw - 0.045, 0, sz * hl - 0.045], [sx * hw + 0.045, sz > 0 ? post : 0.7, sz * hl + 0.045], tint, 0.004)
    for (const s of [-1, 1]) hewn(M.grain, K, F, [s * hw - 0.03, 0.2, -hl], [s * hw + 0.03, T - 0.12, hl], tint, 0.004)
    hewn(M.grain, K, F, [-hw, 0.2, hl - 0.04], [hw, 0.9, hl], tint, 0.004)
    hewn(M.grain, K, F, [-hw, 0.2, -hl], [hw, 0.62, -hl + 0.04], tint, 0.004)
    if (it.posts) for (const s of [-1, 1]) hewn(M.grain, K, F, [-hw - 0.03, 1.62, s * hl - 0.03], [hw + 0.03, 1.7, s * hl + 0.03], tint, 0.004)
    K.box(M.linen, F, 0, T - 0.08, 0, hw - 0.04, 0.08, hl - 0.05, rgb(0.11, 0.25, 0.62), { round: 0.5, uvM: 0.4 })
    K.box(M.linen, F, 0, T - 0.02, -0.18, hw - 0.01, 0.06, hl - 0.25, cloth(room, it.blanket), { round: 0.5, uvM: 0.4 })
    K.box(M.linen, F, 0, T + 0.035, hl - 0.48, hw - 0.01, 0.015, 0.1, CREAM, { round: 0.6, uvM: 0.4 })
    for (let p = 0; p < it.pillows; p++) {
      const x = it.pillows === 1 ? 0 : (p - 0.5) * (hw - 0.05)
      K.blob(M.linen, F, [x + K.j(0.02), T + 0.03, hl - 0.24], it.pillows === 1 ? hw - 0.12 : hw / 2 - 0.06, 0.06, 0.15, CREAM, { rough: 0.04 })
    }
    void rng
  },
  press(it, M, K) {
    const F = F0(it), tint = WOOD(it.hue, -0.09), hx = it.hx, hz = it.hz, T = it.top
    hewn(M.grain, K, F, [-hx, 0.08, -hz], [hx, T - 0.08, hz], tint, 0.004)
    hewn(M.grain, K, F, [-hx - 0.03, 0, -hz - 0.01], [hx + 0.03, 0.08, hz + 0.03], tint, 0.004)
    hewn(M.grain, K, F, [-hx - 0.05, T - 0.08, -hz - 0.02], [hx + 0.05, T, hz + 0.05], tint, 0.004)
    for (const s of [-1, 1]) {
      const x0 = s < 0 ? -hx + 0.04 : 0.01, x1 = s < 0 ? -0.01 : hx - 0.04
      hewn(M.grain, K, F, [x0, 0.14, hz], [x1, T - 0.14, hz + 0.02], WOOD(it.hue, -0.12), 0.003)
      for (const y of [0.4, T - 0.45]) iron(M.grain, K, F, [s < 0 ? x0 - 0.02 : x1 - 0.18, y - 0.015, hz + 0.02], [s < 0 ? x0 + 0.18 : x1 + 0.02, y + 0.015, hz + 0.028])
      K.blob(M.grain, F, [s * 0.05, T * 0.5, hz + 0.03], 0.012, 0.012, 0.01, IRON, { segs: 6, rows: 4 })
    }
  },
  sconce(it, M, K) {
    const F = F0(it)
    iron(M.grain, K, F, [-0.05, -0.12, -0.12], [0.05, 0.12, -0.11])
    // A torch stands in a ring on a bracket, leaning out from the wall, its pitch-soaked head blackened.
    if (it.torch) {
      K.tube(M.grain, [put(F, 0, -0.04, -0.11), put(F, 0, -0.04, -0.03)], [0.008, 0.008], IRON, { segs: 6 })
      K.lathe(M.grain, frame(...put(F, 0, -0.05, -0.03), it.yaw), [[0.026, 0], [0.03, 0], [0.03, 0.02], [0.026, 0.02]], IRON, { segs: 10, flat: true })
      K.rod(M.grain, put(F, 0, -0.2, -0.06), put(F, 0, 0.2, 0), 0.016, 0.02, WOOD(0.3, -0.1))
      K.blob(M.grain, F, [0, 0.23, 0.004], 0.032, 0.06, 0.032, SOOT, { rough: 0.2 })
      return
    }
    K.tube(M.grain, [put(F, 0, -0.06, -0.11), put(F, 0, 0.0, -0.04), put(F, 0, 0.06, 0), put(F, 0, 0.09, 0)], [0.008, 0.008, 0.008, 0.008], IRON, { segs: 6 })
    candleOn(M, K, it.x, it.y + 0.09, it.z, 0.12, IRON)
  },
  tools(it, M, K) {
    const F = F0(it), hx = it.hx, n = it.set.length, ash = WOOD(0.45, -0.04)
    it.set.forEach((kind, i) => {
      const x = -hx + (2 * hx * (i + 0.5)) / n + K.j(0.04), len = kind === 'flail' ? 1.25 : kind === 'scythe' ? 1.6 : 1.45
      // Stood on its foot a hand off the wall, its top resting against it.
      const foot = [x, kind === 'spade' ? 0.3 : 0.02, 0.06], head = [x + K.j(0.08), len, -it.hz + 0.03]
      const L = (p, dy = 0, dz = 0, dx = 0) => put(F, p[0] + dx, p[1] + dy, p[2] + dz)
      K.rod(M.grain, L(foot), L(head), 0.016, 0.014, ash)
      if (kind === 'fork') for (const s of [-1, 0, 1]) K.rod(M.grain, L(head, -0.02, 0, s * 0.03), L(head, 0.22, 0.03, s * 0.05), 0.006, 0.004, IRON, { flat: true })
      else if (kind === 'rake') {
        K.rod(M.grain, L(head, 0, 0, -0.2), L(head, 0, 0, 0.2), 0.016, 0.016, ash)
        for (let k = -3; k <= 3; k++) K.rod(M.grain, L(head, 0, 0, k * 0.06), L(head, -0.01, 0.08, k * 0.06), 0.006, 0.005, ash)
      } else if (kind === 'hoe') iron(M.grain, K, F, [head[0] - 0.08, head[1] - 0.02, head[2] + 0.02], [head[0] + 0.08, head[1] + 0.005, head[2] + 0.14])
      else if (kind === 'spade') {
        K.box(M.grain, F, x, 0.15, 0.06, 0.09, 0.15, 0.008, IRON, { round: 0.2 })
        K.rod(M.grain, L(head, 0, 0, -0.07), L(head, 0, 0, 0.07), 0.014, 0.014, ash)
      } else if (kind === 'scythe') K.tube(M.grain, Array.from({ length: 6 }, (_, k) => L(head, -0.02 - 0.05 * Math.sin((k / 5) * Math.PI), 0.06, 0.1 * k)), Array(6).fill(0.007), IRON, { segs: 4 })
      else if (kind === 'flail') K.rod(M.grain, L(head, 0.02, 0.03, 0.02), L(head, -0.55, 0.06, 0.06), 0.018, 0.018, ash)
    })
  },
  bucket(it, M, K) {
    const F = F0(it), r = it.r, h = it.top
    K.lathe(M.grain, F, [[0, 0.01], [r * 0.8, 0.01], [r * 0.82, 0], [r, h], [r * 0.93, h], [r * 0.76, 0.03], [0, 0.03]], WOOD(it.hue, -0.03), { segs: 16, uvM: 0.2, lobes: [12, 0.01] })
    for (const t of [0.2, 0.8]) { const rr = r * (0.82 + 0.18 * t) + 0.004; K.lathe(M.grain, F, [[rr, h * t - 0.012], [rr + 0.003, h * t], [rr, h * t + 0.012]], IRON, { segs: 16, flat: true }) }
    K.tube(M.grain, Array.from({ length: 7 }, (_, k) => { const q = (k / 6) * Math.PI; return put(F, Math.cos(q) * r, h + Math.sin(q) * r * 0.9, 0) }), Array(7).fill(0.005), IRON, { segs: 4 })
  },
  // Onions or garlic plaited on a cord, or a bunch of herbs, from a hook in the ceiling.
  hanging(it, M, K, room, rng) {
    const F = F0(it, it.y - it.drop)
    K.rod(M.linen, [it.x, it.y, it.z], [it.x, it.y - it.drop, it.z], 0.004, 0.004, CORD, { segs: 4, flat: true })
    if (it.load === 'herbs') {
      for (let s = 0; s < 9; s++) { const q = rng() * TAU, spread = 0.2 + rng() * 0.3; K.leaf(M.linen, [it.x, it.y - it.drop, it.z], norm([Math.cos(q) * spread, -1, Math.sin(q) * spread]), 0.2 + rng() * 0.08, 0.02, [Math.sin(q), 0, -Math.cos(q)], rgb(0.24 + rng() * 0.06, 0.3, 0.3)) }
      return
    }
    const bulb = it.load === 'onions' ? rgb(0.08, 0.55, 0.42) : rgb(0.12, 0.15, 0.72), r = it.load === 'onions' ? 0.04 : 0.03
    for (let k = 0; k < 9; k++) K.blob(M.linen, F, [Math.cos(k * 2.4) * r, -0.04 - k * r * 0.9, Math.sin(k * 2.4) * r], r, r * 0.9, r, bulb, { segs: 8, rows: 5, rough: 0.08 })
  },
}

// --- the light ------------------------------------------------------------------------

const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

/** What the bake needs per room: its own lights, the doorways' borrowed ones, its fill. */
function lightPlan(room) {
  const U = room.U
  const rooms = room.rooms.map((r) => ({ r, cand: [], win: [], glass: 0 }))
  for (const c of room.candles) rooms[c.room].cand.push({ x: c.x, y: c.y, z: c.z, i: c.i, reach: c.torch ? SHADE.torchReach : SHADE.reach })
  const h = room.hearth
  rooms[h.room].cand.push({ x: h.fire.x, y: 0.45, z: h.fire.z, i: SHADE.fire, reach: SHADE.fireReach })
  for (const w of room.windows) {
    const area = w.w * (w.y1 - w.y0)
    rooms[w.room].glass += area
    rooms[w.room].win.push({ p: [w.x + w.nx * T * 0.7, (w.y0 + w.y1) / 2, w.z + w.nz * T * 0.7], ax: [-w.nx, 0, -w.nz], k: SHADE.glass * Math.sqrt(area) })
  }
  const portals = room.doorways.map((d) => ({ a: d.a, b: d.b, p: [(d.x0 + d.x1) / 2, d.y0 + 1.2, (d.z0 + d.z1) / 2] }))
  if (room.upper) {
    const st = room.stair.hole, cx = (st.x0 + st.x1) / 2, cz = (st.z0 + st.z1) / 2
    const a = townRoomAt(room, 0, cx, cz), b = townRoomAt(room, 1, cx, cz)
    if (!a || !b) throw new Error('TownInteriorView: the stair hole opens on no room')
    portals.push({ a: a.id, b: b.id, p: [cx, U - SLAB / 2, cz] })
  }
  // A room's fill from its glass, then a share of a brighter neighbour's.
  const own = rooms.map((R) => DARK_FILL + (1 - DARK_FILL) * Math.min(1, R.glass / 1.2))
  for (const R of rooms) R.fill = own[R.r.id]
  for (const P of portals) {
    rooms[P.a].fill += SHADE.bleed * Math.max(0, own[P.b] - own[P.a])
    rooms[P.b].fill += SHADE.bleed * Math.max(0, own[P.a] - own[P.b])
  }
  // One hop through each doorway: what reaches it, passed on as a light at its middle.
  const reachAt = (R, p) => {
    let c = 0, w = 0
    for (const l of R.cand) c += l.i * Math.exp(-Math.hypot(l.x - p[0], l.y - p[1], l.z - p[2]) / l.reach)
    for (const l of R.win) w += l.k * SHADE.spill * Math.exp(-Math.hypot(l.p[0] - p[0], l.p[1] - p[1], l.p[2] - p[2]) / SHADE.spillM)
    return [c, w]
  }
  const borrowed = rooms.map(() => [])
  for (const P of portals) for (const [from, to] of [[P.a, P.b], [P.b, P.a]]) {
    const [c, w] = reachAt(rooms[from], P.p)
    borrowed[to].push({ p: P.p, c: c * SHADE.door, w: w * SHADE.door })
  }
  rooms.forEach((R, i) => { R.borrowed = borrowed[i] })
  // Under a table, a desk or a bed the fill falls.
  const tops = room.items.filter((it) => ['table', 'desk', 'worktable', 'counter', 'bed', 'bench'].includes(it.kind)).map((it) => {
    const hx = it.kind === 'bed' ? it.wid / 2 : it.hx, hz = it.kind === 'bed' ? it.len / 2 : it.hz
    return { ...footprint(it.x, it.z, it.yaw, hx, hz), y: it.y + it.top - 0.05 }
  })
  return { rooms, tops }
}

/** The room a vertex is lit as: by its level from its height, the nearest room of that level to it. */
function roomOfVertex(room, x, y, z) {
  const level = room.upper && within(grow(room.M, 0.25), x, z) && y > room.U - SLAB / 2 ? 1 : 0
  let best = null, bd = Infinity
  for (const r of room.rooms) {
    if (r.level !== level) continue
    const R = r.rect, d = Math.hypot(Math.max(R.x0 - x, 0, x - R.x1), Math.max(R.z0 - z, 0, z - R.z1))
    if (d < bd) { bd = d; best = r }
  }
  if (!best) throw new Error(`TownInteriorView: no room of level ${level} to light (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`)
  return best
}

/** Per vertex: x the night's fill, y candle and hearth, z window and the daylit fill; `m.cdir` and `m.wdir` the ways its candle and window light come from, weighted by each light's share. */
function bake(room, m, plan) {
  const n = m.count, L = new Float32Array(n * 3), P = m.pos, N = m.nrm, C = new Float32Array(n * 3), W = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const px = P[i * 3], py = P[i * 3 + 1], pz = P[i * 3 + 2], nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2]
    const rm = roomOfVertex(room, px, py, pz), R = plan.rooms[rm.id], r = rm.rect
    const up = py - rm.floor
    let amb = SHADE.amb * (0.8 + 0.2 * ny)
    const edge = Math.max(0, Math.min(px - r.x0, r.x1 - px, pz - r.z0, r.z1 - pz))
    amb *= 1 - (1 - SHADE.corner) * (1 - smooth(0, 0.6, up)) * (1 - smooth(0, 0.8, edge))
    let shaded = 1
    for (const t of plan.tops) if (py < t.y && px > t.x0 - 0.05 && px < t.x1 + 0.05 && pz > t.z0 - 0.05 && pz < t.z1 + 0.05) { shaded = SHADE.under; break }
    amb *= shaded
    let cand = 0
    for (const l of R.cand) {
      const dx = l.x - px, dy = l.y - py, dz = l.z - pz, d = Math.hypot(dx, dy, dz) || 1
      if (d > 6 * l.reach) continue
      const got = SHADE.candle * l.i * Math.exp(-d / l.reach) * (0.35 + 0.65 * Math.max(0, (nx * dx + ny * dy + nz * dz) / d)) * (dy > 0 ? shaded : 1)
      cand += got
      C[i * 3] += (got * dx) / d; C[i * 3 + 1] += (got * dy) / d; C[i * 3 + 2] += (got * dz) / d
    }
    let win = 0
    for (const w of R.win) {
      const dx = px - w.p[0], dy = py - w.p[1], dz = pz - w.p[2], along = dx * w.ax[0] + dz * w.ax[2]
      if (along <= -0.1) continue
      const dl = Math.hypot(dx, dy, dz) || 1, facing = Math.max(0, -(nx * dx + ny * dy + nz * dz) / dl)
      const got = w.k * (SHADE.spill * Math.exp(-dl / SHADE.spillM) * (0.5 + 0.5 * facing) + (smooth(0.15, 0.85, along / dl) * Math.max(0.2, facing)) / (1 + (dl / SHADE.beamM) ** 2))
      win += got
      W[i * 3] -= (got * dx) / dl; W[i * 3 + 1] -= (got * dy) / dl; W[i * 3 + 2] -= (got * dz) / dl
    }
    for (const b of R.borrowed) {
      const dx = b.p[0] - px, dy = b.p[1] - py, dz = b.p[2] - pz, d = Math.hypot(dx, dy, dz) || 1
      const k = Math.exp(-d / SHADE.doorReach) * (0.35 + 0.65 * Math.max(0, (nx * dx + ny * dy + nz * dz) / d))
      cand += SHADE.candle * b.c * k
      win += b.w * k
      for (let a = 0; a < 3; a++) { const u = [dx, dy, dz][a] / d; C[i * 3 + a] += SHADE.candle * b.c * k * u; W[i * 3 + a] += b.w * k * u }
    }
    L[i * 3] = amb * DARK_FILL
    L[i * 3 + 1] = SHADE.cap * (1 - Math.exp(-cand / SHADE.cap))
    L[i * 3 + 2] = win * (0.5 + 0.5 * shaded) * smooth(0, 0.6, edge + 0.3) + amb * (R.fill - DARK_FILL) * LEVELS.amb / LEVELS.win
  }
  m.lit = L
  m.cdir = C
  m.wdir = W
}

/**
 * The meshes for town house `room`, set at (ox, oy, oz). `tex` is loadInteriorTextures()'s. `update(t, dayness, eye)` flickers the candles and the hearth and brings the windows up with the day.
 */
export class TownInteriorView {
  constructor(room, tex, ox, oy, oz) {
    if (!room.town) throw new Error('TownInteriorView: needs a rollTownInterior room')
    this.room = room
    this.group = new THREE.Group()
    this.group.position.set(ox, oy, oz)
    this.uniforms = houseUniforms()
    const rng = mulberry32(hash32(room.seed, room.index, 0x70e1))
    const K = kit(rng)
    const M = Object.fromEntries(MESHES.map((id) => [id, new Mesher()]))
    buildShell(room, M, K, rng)
    for (const it of room.items) {
      const make = ITEMS[it.kind]
      if (!make) throw new Error(`TownInteriorView: no builder for ${it.kind}`)
      make(it, M, K, room, rng)
    }
    const T2 = houseTextures(tex)
    const speckMap = speckleTexture()
    const maps = { floor: { plank: T2.plank, flag: T2.flag, earth: speckMap }[room.floor.kind], plank: T2.plank, wall: { logs: T2.boards, boards: T2.boards, panel: T2.panel, plaster: T2.plaster, timbered: T2.timbered }[room.wall.kind], stone: T2.flag, grain: T2.grain, linen: T2.linen, pages: T2.pages, window: T2.leaded }
    const plan = lightPlan(room)
    for (const id of MESHES) {
      const m = M[id]
      if (m.count === 0) continue
      bake(room, m, plan)
      if (id === 'window') glaze(m)
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(m.pos, 3))
      g.setAttribute('normal', new THREE.Float32BufferAttribute(m.nrm, 3))
      g.setAttribute('speck', new THREE.Float32BufferAttribute(m.speck, 1))
      g.setAttribute('shine', new THREE.Float32BufferAttribute(m.shine, 1))
      g.setAttribute('cdir', new THREE.Float32BufferAttribute(m.cdir, 3))
      g.setAttribute('wdir', new THREE.Float32BufferAttribute(m.wdir, 3))
      g.setAttribute('tuv', new THREE.Float32BufferAttribute(m.uv, 2))
      g.setAttribute('tint', new THREE.Float32BufferAttribute(m.tint, 3))
      g.setAttribute('light', new THREE.Float32BufferAttribute(m.lit, 3))
      g.setIndex(m.idx)
      g.computeBoundingSphere()
      const mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: { map: { value: maps[id] }, speckMap: { value: speckMap }, ...this.uniforms }, fog: false })
      const mesh = new THREE.Mesh(g, mat)
      mesh.name = `town-interior-${id}`
      mesh.frustumCulled = false
      this.group.add(mesh)
    }
    if (!maps.floor || !maps.wall) throw new Error(`TownInteriorView: no texture for a ${room.floor.kind} floor or ${room.wall.kind} walls`)
    // A poor house can be lit by torches alone, and then has no candle flames.
    const candles = room.candles.filter((c) => !c.torch)
    this.flames = candles.length ? buildFlames(candles, ox, oy, oz) : null
    if (this.flames) this.group.add(this.flames.group)
    // The hearth's fire and each torch's are one set of fire flames, the hearth first.
    const f = room.hearth.fire, torches = room.candles.filter((c) => c.torch)
    this.fire = new TriFlames(1 + torches.length, TRI_FIRE, { seed: room.index + 7 })
    this.fire.place(0, ox + f.x, oy + f.y, oz + f.z, { height: 0.5, radius: 0.22 })
    torches.forEach((c, i) => this.fire.place(1 + i, ox + c.x, oy + c.y - 0.08, oz + c.z, { height: 0.22, radius: 0.06, phase: i * 1.7 }))
    this.group.add(this.fire.group)
  }

  update(t, dayness, eye) {
    const f = 0.9 + 0.06 * Math.sin(t * 7.3) + 0.04 * Math.sin(t * 13.7 + 1.3)
    this.uniforms.uFlicker.value = f
    skyThroughGlass(dayness, this.uniforms.uSky.value)
    if (this.flames) this.flames.update(t, f, eye)
    this.fire.update(t, [f, f, f], eye)
  }

  dispose() {
    this.group.removeFromParent()
    // The made-in-code textures are cached for the next house; only geometry and materials are ours.
    this.group.traverse((o) => {
      o.geometry?.dispose()
      if (o.material && o.material.isShaderMaterial) o.material.dispose()
    })
    if (this.flames) this.flames.dispose()
    this.fire.dispose()
  }
}
