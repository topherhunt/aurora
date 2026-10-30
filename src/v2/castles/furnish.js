// What stands in a castle (design/44-castles.md, Rooms and props): the room plan (each room node cut into chambers by stone
// partitions, each chamber given a role), and props as records { kind, x, y, z, yaw, w, d } -- plan centre, floor height, yaw about
// +y, footprint -- in the court, on the roofs and walks (exterior metres) and in every chamber (interior metres, exterior times
// CASTLE.scale). Every portal keeps a clear disc and every pair of a chamber's portals a clear lane, so no prop blocks the maze.
import { mulberry32 } from '../../sim/mathx.js'
import { CASTLE } from './layout.js'
import { dungeonCell, dungeonPlan } from './dungeon.js'

const C = CASTLE.cell, H = CASTLE.storey, S = CASTLE.scale, V = CASTLE.tall, SH = H * V
const INSET = 0.4, WT = 0.3
// Partitions: thickness, and the doorway each has at one cell's middle along it.
export const PARTITION = { t: 0.4, door: 1.6, doorH: 3 }
// Footprints [w, d] in metres; the mesher in shell.js draws each kind.
export const PROP = {
  barrel: [0.7, 0.7], crate: [0.8, 0.8], sacks: [0.9, 0.6], bench: [1.8, 0.45], table: [2.4, 1.0], longtable: [4.2, 1.1], stool: [0.45, 0.45],
  bed: [1.0, 2.0], chest: [1.0, 0.6], rack: [1.6, 0.4], shelf: [1.4, 0.4], hay: [1.9, 0.55], cart: [1.6, 2.6], well: [1.6, 1.6],
  dummy: [0.6, 0.6], throne: [1.0, 0.9], brazier: [0.6, 0.6], banner: [1.2, 0.1], woodpile: [1.6, 0.7],
  hearth: [2.2, 0.9], oven: [1.6, 1.2], cauldron: [0.8, 0.8], herbs: [1.4, 0.2], cask: [1.2, 0.9], bucket: [0.4, 0.4], basket: [0.5, 0.5],
  bunk: [1.0, 2.0], shields: [1.6, 0.12], armour: [0.6, 0.5], arrows: [0.6, 0.6], grind: [0.9, 0.6], anvil: [0.7, 0.4],
  dais: [3.6, 2.4], carpet: [1.4, 4], tapestry: [1.8, 0.1], chandelier: [1.2, 1.2], fourposter: [1.6, 2.2], wardrobe: [1.2, 0.6],
  desk: [1.3, 0.7], rug: [2.4, 1.6], altar: [1.6, 0.8], maptable: [2.0, 1.4], cot: [0.8, 1.9], workbench: [2.0, 0.8], candles: [0.4, 0.4],
  stack3: [1.36, 0.92], stack5: [2.02, 0.92], stand3: [1.38, 0.7], stand5: [2.06, 0.7],
  sconce: [0.3, 0.25], target: [1.2, 0.5], pell: [0.4, 0.4], yard: [4, 4], forge: [2.2, 1.6], trough: [1.8, 0.6], block: [0.6, 0.6],
  bowrack: [1.6, 0.3], stones: [0.9, 0.9], chair: [0.5, 0.5], dresser: [1.4, 0.5], grain: [1.3, 0.8], veg: [0.9, 0.7], kegs: [1.2, 0.6], jars: [1.2, 0.4],
  coal: [1.0, 0.8], hams: [1.2, 0.2], chains: [1.0, 0.12], straw: [1.4, 1.0], bones: [0.9, 0.6], wreck: [0.9, 0.9], cage: [1.2, 1.2],
  jug: [0.18, 0.18], bowl: [0.24, 0.24], loaf: [0.26, 0.16], cup: [0.1, 0.1], candle: [0.06, 0.06], book: [0.26, 0.2],
}
// Flames each kind carries, in its own frame (shell.js prop): [u, y, v, height, radius].
const FLAMES = {
  brazier: [[0, 1.0, 0, 0.5, 0.22]], hearth: [[0, 0.28, 0.05, 0.75, 0.38]], oven: [[0, 0.36, 0.64, 0.22, 0.16]], cauldron: [[0, 0.02, 0, 0.28, 0.22]],
  forge: [[-0.35, 0.84, -0.2, 0.42, 0.28]], sconce: [[0, 2.3, 0.08, 0.3, 0.09]], candles: [[0, 1.35, 0, 0.09, 0.025]], candle: [[0, 0.18, 0, 0.08, 0.02]],
  altar: [[-0.55, 1.28, 0, 0.09, 0.025], [0.55, 1.28, 0, 0.09, 0.025]],
  chandelier: [[-0.45, 3.88, -0.45, 0.09, 0.025], [0.45, 3.88, -0.45, 0.09, 0.025], [0.45, 3.88, 0.45, 0.09, 0.025], [-0.45, 3.88, 0.45, 0.09, 0.025]],
}
// What each role holds: `must` placed first (one each), then `wall` kinds round it, a `centre` piece, tableware on its tables.
const KIT = {
  throne: { wall: ['banner', 'tapestry', 'tapestry', 'brazier', 'sconce', 'sconce', 'chest', 'shelf', 'chair', 'chair'] },
  kitchen: { must: ['hearth', 'oven', 'cauldron'], wall: ['barrel', 'sacks', 'shelf', 'herbs', 'herbs', 'crate', 'cask', 'bucket', 'basket', 'sconce', 'veg', 'jars', 'hams', 'coal'], centre: ['table'], ware: true },
  pantry: { wall: ['barrel', 'sacks', 'grain', 'veg', 'veg', 'crate', 'cask', 'kegs', 'jars', 'jars', 'basket', 'herbs', 'hams', 'sconce'] },
  mess: { wall: ['bench', 'shelf', 'brazier', 'banner', 'sconce', 'sconce', 'cask', 'barrel', 'kegs', 'dresser'], centre: ['longtable', 'table'], ware: true, chandelier: true },
  guard: { must: ['rack'], wall: ['rack', 'bench', 'chest', 'barrel', 'sconce', 'shields', 'chair', 'kegs'], centre: ['table'], ware: true },
  passage: { wall: ['brazier', 'sconce', 'sconce', 'barrel', 'stack3', 'stack5', 'stand3', 'stand5'] },
  armoury: { must: ['anvil', 'grind'], wall: ['rack', 'rack', 'shields', 'shields', 'armour', 'armour', 'arrows', 'chest', 'crate', 'sconce'] },
  barracks: { must: ['bunk', 'bunk'], wall: ['bunk', 'bunk', 'bunk', 'chest', 'chest', 'rack', 'sconce', 'shields'], centre: ['table'], ware: true },
  bedchamber: { must: ['fourposter'], wall: ['wardrobe', 'chest', 'desk', 'tapestry', 'candles', 'sconce', 'shelf', 'dresser', 'chair'], rug: true, ware: true },
  chapel: { must: ['altar'], wall: ['candles', 'candles', 'bench', 'tapestry', 'banner'], centre: ['bench'] },
  maproom: { wall: ['shelf', 'shelf', 'chest', 'candles', 'banner', 'sconce', 'desk', 'chair'], centre: ['maptable'], ware: true },
  infirmary: { must: ['cot', 'cot'], wall: ['cot', 'cot', 'shelf', 'herbs', 'bucket', 'chest', 'candles', 'chair', 'jars'] },
  treasury: { must: ['chest', 'chest'], wall: ['chest', 'chest', 'chest', 'crate', 'candles', 'sconce'] },
  library: { wall: ['shelf', 'shelf', 'shelf', 'shelf', 'desk', 'candles', 'sconce', 'chair', 'chair'], centre: ['table'], ware: true },
  cellar: { wall: ['cask', 'cask', 'cask', 'barrel', 'kegs', 'kegs', 'stack3', 'stand5', 'jars', 'veg', 'crate', 'sconce'] },
  bakehouse: { must: ['oven'], wall: ['sacks', 'grain', 'grain', 'basket', 'shelf', 'barrel', 'coal', 'sconce'], centre: ['table'], ware: true },
  workshop: { must: ['workbench'], wall: ['workbench', 'crate', 'woodpile', 'barrel', 'rack', 'sconce', 'coal', 'chair'] },
  store: { wall: ['barrel', 'stack5', 'stand3', 'crate', 'crate', 'sacks', 'grain', 'veg', 'kegs', 'coal', 'woodpile', 'sconce'] },
  granary: { wall: ['sacks', 'grain', 'grain', 'grain', 'hay', 'basket', 'sconce'] },
  servants: { must: ['bed'], wall: ['bed', 'bed', 'chest', 'stool', 'shelf', 'sconce', 'dresser'] },
  guest: { must: ['bed'], wall: ['chest', 'wardrobe', 'candles', 'desk', 'tapestry', 'dresser', 'chair'], rug: true, ware: true },
  watch: { wall: ['bench', 'arrows', 'chest', 'sconce', 'stool', 'barrel', 'chair'] },
  arsenal: { must: ['bowrack'], wall: ['arrows', 'arrows', 'stones', 'stones', 'barrel', 'bowrack', 'sconce'] },
  linen: { wall: ['chest', 'chest', 'wardrobe', 'dresser', 'dresser', 'shelf', 'basket', 'basket', 'sconce'] },
  study: { must: ['desk'], wall: ['shelf', 'shelf', 'chest', 'candles', 'tapestry', 'chair', 'dresser'], rug: true },
  sewing: { must: ['workbench'], wall: ['basket', 'basket', 'chest', 'shelf', 'tapestry', 'stool', 'candles', 'chair'], centre: ['table'], ware: true },
  scullery: { wall: ['bucket', 'bucket', 'barrel', 'shelf', 'basket', 'crate', 'sconce', 'veg', 'jars'], centre: ['table'], ware: true },
  woodstore: { wall: ['woodpile', 'woodpile', 'woodpile', 'crate', 'block', 'coal'] },
}
// Rooms each castle has one of, if a chamber is left for them, in the order they are tried.
const EXTRAS = ['chapel', 'maproom', 'treasury', 'infirmary', 'library', 'bakehouse', 'cellar', 'workshop']
// What the chambers left over become, each list taken in turn: on the ground, above it, and at a tower's top.
const GROUND = ['store', 'granary', 'scullery', 'woodstore']
const UPPER = ['servants', 'guest', 'linen', 'study', 'sewing', 'store', 'workshop', 'servants', 'guest']
const TOWER_TOP = ['watch', 'arsenal']
const WARE = ['jug', 'bowl', 'bowl', 'loaf', 'cup', 'cup', 'candle', 'book']
const SURFACE = { table: 0.82, longtable: 0.82, desk: 0.8, maptable: 0.83, dresser: 1.0 }
const COURT_KINDS = ['barrel', 'stack3', 'stack5', 'stand3', 'stand5', 'crate', 'hay', 'hay', 'cart', 'rack', 'woodpile', 'sacks', 'brazier', 'trough']
const TRAIN_KINDS = ['dummy', 'dummy', 'pell', 'rack', 'hay']
// Flames a chamber may carry as sconces and braziers.
const TORCHES = new Set(['sconce', 'brazier']), MAX_TORCHES = 2
const WORK_KINDS = ['trough', 'block', 'woodpile', 'anvil', 'barrel', 'crate']
const ROOF_KINDS = ['arrows', 'arrows', 'bowrack', 'stones', 'stones', 'barrel']
const DUNGEON_KINDS = ['barrel', 'crate', 'crate', 'sacks', 'grain', 'kegs', 'bucket', 'stones', 'cot', 'cask', 'chains', 'chains', 'straw', 'straw', 'bones', 'wreck', 'wreck', 'cage']
const CLEAR = 1.3, LANE = 0.75, GAP = 0.15

/** Distance from p to segment ab, in plan. */
function segDist(p, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2)) : 0
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz)
}

/** A footprint's plan corners. */
const cornersOf = (x, z, yaw, w, d) => {
  const c = Math.cos(yaw), s = Math.sin(yaw)
  return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([u, v]) => [x + u * c + v * s, z - u * s + v * c])
}
/** Whether two plan quads are GAP apart along one of their edges' normals. */
function apart(A, B) {
  for (const P of [A, B]) for (let i = 0; i < 4; i++) {
    const a = P[i], b = P[(i + 1) % 4], l = Math.hypot(b[0] - a[0], b[1] - a[1]), n = [(b[1] - a[1]) / l, (a[0] - b[0]) / l]
    const pa = A.map((p) => p[0] * n[0] + p[1] * n[1]), pb = B.map((p) => p[0] * n[0] + p[1] * n[1])
    if (Math.min(...pa) >= Math.max(...pb) + GAP || Math.min(...pb) >= Math.max(...pa) + GAP) return true
  }
  return false
}
/** Plan point (u, v) of record o's frame. */
const frame = (o, u, v) => [o.x + u * Math.cos(o.yaw) + v * Math.sin(o.yaw), o.z - u * Math.sin(o.yaw) + v * Math.cos(o.yaw)]

/** Places props along the inside of rect r [x0, z0, x1, z1] (or a disc when `round`), their backs to the walls, then a centre
 * piece; nothing within CLEAR of a portal, LANE of a lane between portals, or overlapping what is placed. */
function fillRect(rng, r, round, portals, kinds, y, centre, out, cap = Infinity) {
  const placed = out.map((o) => cornersOf(o.x, o.z, o.yaw, o.w, o.d)), n0 = out.length
  const lanes = []
  for (let i = 0; i < portals.length; i++) for (let j = i + 1; j < portals.length; j++) lanes.push([portals[i], portals[j]])
  const free = (pts, cx, cz) => pts.every((p) => portals.every((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) > CLEAR) && lanes.every(([a, b]) => segDist(p, a, b) > LANE))
    && [[cx, cz], ...pts].every((p) => portals.every((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) > CLEAR))
    && placed.every((q) => apart(pts, q))
  const put = (kind, x, z, yaw) => {
    const [w, d] = PROP[kind], pts = cornersOf(x, z, yaw, w, d)
    if (out.length - n0 >= cap || !pts.every(inside) || !free(pts, x, z)) return false
    placed.push(pts)
    out.push({ kind, x, y, z, yaw, w, d })
    return true
  }
  const [x0, z0, x1, z1] = r, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2
  const inside = round ? (p) => Math.hypot(p[0] - cx, p[1] - cz) < (x1 - x0) / 2 * Math.cos(Math.PI / 12) - 0.02
    : (p) => p[0] > x0 - 0.01 && p[0] < x1 + 0.01 && p[1] > z0 - 0.01 && p[1] < z1 + 0.01
  const tries = Math.round(((x1 - x0) + (z1 - z0)) * 0.8)
  for (let t = 0; t < tries; t++) {
    const kind = kinds[Math.floor(rng() * kinds.length)], [w, d] = PROP[kind]
    if (round) {
      const R = (x1 - x0) / 2, a = rng() * Math.PI * 2, rr = R - d / 2 - 0.1
      put(kind, cx + Math.cos(a) * rr, cz + Math.sin(a) * rr, Math.atan2(Math.cos(a), Math.sin(a)) + Math.PI)
      continue
    }
    // A wall, then a spot along it; the prop's back (its -d side) to the wall.
    const side = Math.floor(rng() * 4), u = rng(), e = w / 2 + 0.1
    const ax = x0 + e + (x1 - x0 - 2 * e) * u, az = z0 + e + (z1 - z0 - 2 * e) * u
    const [x, z, yaw] = side === 0 ? [ax, z0 + d / 2 + 0.05, 0] : side === 1 ? [ax, z1 - d / 2 - 0.05, Math.PI]
      : side === 2 ? [x0 + d / 2 + 0.05, az, Math.PI / 2] : [x1 - d / 2 - 0.05, az, -Math.PI / 2]
    put(kind, x, z, yaw)
  }
  if (centre && !round) {
    const along = x1 - x0 >= z1 - z0, yaw = along ? 0 : Math.PI / 2
    for (const kind of centre) if (put(kind, cx, cz, yaw)) {
      if (kind === 'longtable' || kind === 'table') {
        const [w, d] = PROP[kind], off = d / 2 + 0.35
        for (const s of [-1, 1]) put('bench', cx + (along ? 0 : s * off), cz + (along ? s * off : 0), yaw)
      }
      break
    }
  }
}

/** `must` kinds one each, then `wall` kinds, `centre`, and `wall` kinds again, into `out`. */
function fillKit(rng, r, round, portals, kit, y, out) {
  for (const kind of kit.must ?? []) fillRect(rng, r, round, portals, [kind], y, null, out, 1)
  fillRect(rng, r, round, portals, kit.wall, y, kit.centre ?? null, out)
  fillRect(rng, r, round, portals, kit.wall, y, null, out)
}

/** Tableware scattered on the tops of the tables among `list`, appended to it. */
function setTables(rng, list) {
  for (const o of [...list]) {
    const top = SURFACE[o.kind]
    if (top === undefined) continue
    const n = 1 + Math.floor(rng() * Math.min(6, o.w * 1.6))
    for (let i = 0; i < n; i++) {
      const kind = WARE[Math.floor(rng() * WARE.length)], [u, v] = [(rng() - 0.5) * (o.w - 0.4), (rng() - 0.5) * (o.d - 0.35)]
      const [x, z] = frame(o, u, v)
      // Two pieces overlapping would show each other's tops through the same plane.
      if (list.some((p) => p.y === o.y + top && Math.hypot(p.x - x, p.z - z) < 0.32)) continue
      list.push({ kind, x, y: o.y + top, z, yaw: rng() * Math.PI * 2, w: PROP[kind][0], d: PROP[kind][1] })
    }
  }
}

/** Every flame among `records`: a flat array of x, y, z, height, radius per flame, in the records' units. */
export function propFlames(records) {
  const out = []
  for (const o of records) for (const [u, y, v, h, r] of FLAMES[o.kind] ?? []) {
    const [x, z] = frame(o, u, v)
    out.push(x, o.y + y, z, h, r)
  }
  return out
}

/** The doorways, ladders and spiral foot or hole a room node `n` has at its storey, as interior plan points. */
function nodePortals(lay, n) {
  const out = [], disc = (x, z) => { for (let i = 0; i < 7; i++) out.push([x * S + (i && Math.cos(i * Math.PI / 3) * 1.2), z * S + (i && Math.sin(i * Math.PI / 3) * 1.2)]) }
  const down = dungeonPlan(lay).stair
  if (down.node === n) disc(down.x, down.z)
  for (const e of lay.edges) {
    if (e.a !== n && e.b !== n) continue
    for (const d of e.doors) if (Math.abs(d.y - n.k * H) < 0.1) out.push([d.x * S, d.z * S])
    // A spiral climbs from its foot room and arrives in the one above through its hole; both keep its disc and a way round it clear.
    if (e.stair) disc(e.stair.x, e.stair.z)
    if (e.ladder) out.push([e.ladder.x * S, e.ladder.z * S])
  }
  return out
}

const plans = new WeakMap()
/**
 * A layout's room plan: `chambers` { node, k, rect (its air, interior metres), cells, round, role, portals } and `walls` { k, axis,
 * at, lo, hi, door: [g0, g1] } -- a partition on the plane axis = at from lo to hi, open over door. Room nodes are cut on cell lines
 * (a partition is then 4 interior metres off any spiral and 2.4 off any ladder, and its doorway between the cells' doors), the
 * throne's node into pieces of 6 cells at most, the mess's 4, the rest 2 or 1.
 */
export function roomPlan(lay) {
  if (plans.has(lay)) return plans.get(lay)
  const rng = mulberry32(lay.seed * 7333 + 11), PT = PARTITION.t
  const nodes = lay.nodes.filter((n) => n.kind === 'room')
  const cells = (n) => n.w * n.d
  const biggest = (list) => list.reduce((a, b) => (cells(b) > cells(a) ? b : a), list[0])
  const throneNode = biggest(nodes.filter((n) => n.sec.kind === 'keep' && n.k === 1))
  const messNode = biggest(nodes.filter((n) => n !== throneNode && (n.sec.kind === 'keep' || n.sec.kind === 'hall') && n.k <= 2))
  const chambers = [], walls = []
  for (const n of nodes) {
    const air = [(lay.X(n.x0) + INSET) * S + WT, (lay.Z(n.z0) + INSET) * S + WT, (lay.X(n.x0 + n.w) - INSET) * S - WT, (lay.Z(n.z0 + n.d) - INSET) * S - WT]
    const cap = n === throneNode ? 6 : n === messNode ? 4 : n.sec.round || (n.sec.kind === 'gate' && n.k === 0) ? Infinity : 2
    const cut = (p) => {
      const many = p.w * p.d
      if (many <= 1 || many <= cap && !(cap === 2 && many === 2 && rng() < 0.5)) {
        chambers.push({ node: n, k: n.k, rect: p.r, cells: many, round: n.sec.round, role: null, portals: [] })
        return
      }
      const alongX = p.w > p.d || (p.w === p.d && rng() < 0.5), span = alongX ? p.w : p.d, i = 1 + Math.floor(rng() * (span - 1))
      const line = (alongX ? lay.X(p.x0 + i) : lay.Z(p.z0 + i)) * S, t = Math.floor(rng() * (alongX ? p.d : p.w))
      const mid = (alongX ? lay.Z(p.z0 + t + 0.5) : lay.X(p.x0 + t + 0.5)) * S
      const [lo, hi] = alongX ? [p.r[1], p.r[3]] : [p.r[0], p.r[2]]
      walls.push({ k: n.k, axis: alongX ? 'x' : 'z', at: line, lo, hi, door: [mid - PARTITION.door / 2, mid + PARTITION.door / 2], y: n.k * SH })
      if (alongX) {
        cut({ x0: p.x0, z0: p.z0, w: i, d: p.d, r: [p.r[0], p.r[1], line - PT / 2, p.r[3]] })
        cut({ x0: p.x0 + i, z0: p.z0, w: p.w - i, d: p.d, r: [line + PT / 2, p.r[1], p.r[2], p.r[3]] })
      } else {
        cut({ x0: p.x0, z0: p.z0, w: p.w, d: i, r: [p.r[0], p.r[1], p.r[2], line - PT / 2] })
        cut({ x0: p.x0, z0: p.z0 + i, w: p.w, d: p.d - i, r: [p.r[0], line + PT / 2, p.r[2], p.r[3]] })
      }
    }
    cut({ x0: n.x0, z0: n.z0, w: n.w, d: n.d, r: air })
  }
  const inRect = (r, [x, z], m) => x > r[0] - m && x < r[2] + m && z > r[1] - m && z < r[3] + m
  for (const c of chambers) {
    c.portals = nodePortals(lay, c.node).filter((p) => inRect(c.rect, p, 1.25))
    for (const w of walls) if (w.k === c.k) {
      const p = w.axis === 'x' ? [w.at, (w.door[0] + w.door[1]) / 2] : [(w.door[0] + w.door[1]) / 2, w.at]
      if (inRect(c.rect, p, PT)) c.portals.push(p)
    }
  }

  // Roles, the grand rooms first, each near the one it serves.
  const centre = (c) => [(c.rect[0] + c.rect[2]) / 2, (c.rect[1] + c.rect[3]) / 2]
  const dist = (a, b) => Math.hypot(centre(a)[0] - centre(b)[0], centre(a)[1] - centre(b)[1]) + Math.abs(a.k - b.k) * 6
  const area = (c) => (c.rect[2] - c.rect[0]) * (c.rect[3] - c.rect[1])
  const free = (f) => chambers.filter((c) => c.role === null && f(c))
  const take = (role, list, rank) => {
    if (!list.length) return null
    const c = list.reduce((a, b) => (rank(b) < rank(a) ? b : a))
    c.role = role
    return c
  }
  const gateRoom = chambers.find((c) => c.node.sec.kind === 'gate' && c.k === 0)
  for (const c of chambers) if (c.node.sec.kind === 'gate') c.role = c.k === 0 ? 'passage' : 'guard'
  const throne = take('throne', free((c) => c.node === throneNode && !c.round), (c) => -area(c))
  const kitchen = take('kitchen', free((c) => c.k === 0 && !c.round), (c) => dist(c, throne))
  take('pantry', free((c) => c.k === 0), (c) => dist(c, kitchen))
  take('mess', free((c) => c.k <= 2 && (c.node.sec.kind === 'keep' || c.node.sec.kind === 'hall') && !c.round), (c) => -area(c))
  for (let i = 1 + Math.floor(rng() * 2); i > 0; i--) take('armoury', free((c) => c.k >= 1), (c) => dist(c, gateRoom))
  for (let i = 2 + Math.floor(rng() * 2); i > 0; i--) take('barracks', free((c) => c.k >= 1 && c.k < c.node.sec.floors - 1), (c) => -area(c) + rng() * 20)
  const top = (c) => c.k === c.node.sec.floors - 1
  take('bedchamber', free((c) => c.node.sec.kind === 'keep' && top(c)), (c) => -area(c))
  take('bedchamber', free((c) => c.k >= 2), (c) => -c.k * 10 - area(c) / 100)
  for (const role of EXTRAS) {
    const ground = role === 'cellar' || role === 'bakehouse'
    take(role, free((c) => (ground ? c.k === 0 : c.k >= 1)), role === 'treasury' ? (c) => dist(c, throne) : () => rng())
  }
  const turn = { g: 0, u: Math.floor(rng() * UPPER.length), t: 0 }
  for (const c of chambers) if (c.role === null) {
    c.role = c.k === 0 ? GROUND[turn.g++ % GROUND.length] : top(c) && c.node.sec.kind !== 'keep' ? TOWER_TOP[turn.t++ % 2] : UPPER[turn.u++ % UPPER.length]
  }
  const plan = { chambers, walls }
  plans.set(lay, plan)
  return plan
}

/** The court's props, in exterior metres on the court floor (y 0): masonry-side clutter round the rim, a training ground in a
 * corner, a work yard by the forge, and a well in the middle. */
export function courtProps(lay) {
  const rng = mulberry32(lay.seed * 6271 + 3), out = [], portals = []
  let gateIn = null
  for (const e of lay.edges) {
    for (const d of e.doors) if (d.y === 0) {
      const p = [d.x + (d.axis === 'x' ? d.side * 1.2 : 0), d.z + (d.axis === 'z' ? d.side * 1.2 : 0)]
      portals.push(p)
      if (e.kind === 'door' && e.b.sec.kind === 'gate') gateIn = p
    }
    if (e.flight) {
      const f = e.flight, cm = (f.c0 + f.c1) / 2, lo = Math.min(f.a0, f.a1), hi = Math.max(f.a0, f.a1)
      // A flight is solid from foot to landing: keep its whole length clear, and the court before its foot.
      for (let a = lo; a <= hi + 1e-6; a += 0.8) portals.push(f.axis === 'x' ? [a, cm] : [cm, a])
      const foot = f.a0 - Math.sign(f.a1 - f.a0)
      portals.push(f.axis === 'x' ? [foot, cm] : [cm, foot])
    }
  }
  if (!gateIn) throw new Error(`castle ${lay.seed}: no gate door onto the court`)
  const near = (r) => portals.filter((p) => p[0] > r[0] - 3 && p[0] < r[2] + 3 && p[1] > r[1] - 3 && p[1] < r[3] + 3)
  const cellRect = (gx, gz, m = 0) => [lay.X(gx) + m, lay.Z(gz) + m, lay.X(gx + 1) - m, lay.Z(gz + 1) - m]
  const cells = []
  for (let x = 0; x < lay.cw; x++) for (let z = 0; z < lay.cd; z++) if (!lay.occAt(x, z)) cells.push([x, z])
  const sides = ([gx, gz]) => [[-1, 0], [1, 0], [0, -1], [0, 1]].filter(([dx, dz]) => lay.occAt(gx + dx, gz + dz)).length
  const rim = (c) => sides(c) > 0
  // The section a record's back stands against, if any.
  const behind = (o) => { const bx = o.x - Math.sin(o.yaw) * (o.d / 2 + 0.3), bz = o.z - Math.cos(o.yaw) * (o.d / 2 + 0.3); return lay.occAt(Math.floor((bx - lay.X(0)) / C), Math.floor((bz - lay.Z(0)) / C)) }
  const mid = [Math.floor(lay.cw / 2), Math.floor(lay.cd / 2)]
  const fromGate = ([gx, gz]) => Math.hypot(lay.X(gx + 0.5) - gateIn[0], lay.Z(gz + 0.5) - gateIn[1])
  // The training ground: a corner of the court far from the gate, its targets leant on the masonry so a missed arrow meets stone.
  // The work yard: the rim cell nearest the gate but its own.
  const train = cells.filter(rim).reduce((a, b) => (fromGate(b) + 6 * sides(b) > fromGate(a) + 6 * sides(a) ? b : a))
  const work = cells.filter((c) => rim(c) && c !== train && fromGate(c) > 3).sort((a, b) => fromGate(a) - fromGate(b))[0]
  for (const c of cells) {
    const r = cellRect(...c)
    if (c === train) {
      // The sand goes in after, so it is no obstacle. A target's foot stands clear of the root crown and its top leans on the masonry
      // at 1.4 m: a curtain wall's face is 0.8 m into its cell, its crown out to the cell's edge at grade; a tower's face is the
      // edge, its crown 0.8 m out. Each as [foot, top] in from the cell's edge (shell.js profile).
      const n0 = out.length
      fillRect(rng, r, false, near(r), ['target'], 0.05, null, out, 2)
      for (let i = out.length - 1; i >= n0; i--) {
        const o = out[i], by = behind(o), [foot, top] = by && by.kind === 'wall' ? [0.15, -0.5] : [0.85, 0.3], sh = foot - 0.05
        const [x, z] = [o.x + Math.sin(o.yaw) * sh, o.z + Math.cos(o.yaw) * sh]
        if (by && near(r).every((p) => Math.hypot(p[0] - x, p[1] - z) > CLEAR + 0.4)) Object.assign(o, { x, z, lean: foot - top })
        else out.splice(i, 1)
      }
      fillRect(rng, cellRect(...c, 0.6), false, near(r), TRAIN_KINDS, 0.05, null, out)
      const [x, z] = [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2]
      if (out.length > n0) out.push({ kind: 'yard', x, y: 0.05, z, yaw: 0, w: r[2] - r[0] - 0.8, d: r[3] - r[1] - 0.8 })
      continue
    }
    if (c === work) {
      fillRect(rng, r, false, near(r), ['forge'], 0, null, out, 1)
      fillRect(rng, r, false, near(r), WORK_KINDS, 0, null, out)
      continue
    }
    if (!rim(c)) continue
    const n0 = out.length
    fillRect(rng, r, false, near(r), COURT_KINDS, 0, null, out)
    // A rim cell's clutter hugs the masonry it borders: drop any that faces open court.
    for (let i = out.length - 1; i >= n0; i--) if (!behind(out[i])) out.splice(i, 1)
  }
  // A well in the court's middle cell when the yard is three cells deep and wide.
  if (lay.cw >= 3 && lay.cd >= 3) {
    const x = lay.X(mid[0] + 0.5), z = lay.Z(mid[1] + 0.5)
    if (!lay.occAt(...mid) && portals.every((p) => Math.hypot(p[0] - x, p[1] - z) > 2.2) && !out.some((o) => Math.hypot(o.x - x, o.z - z) < 2)) out.push({ kind: 'well', x, y: 0, z, yaw: 0, w: 1.6, d: 1.6 })
  }
  return out
}

/** Every used roof's archers' stores and brazier, and the walks' along their outer parapets, in exterior metres at their floors. */
export function roofProps(lay) {
  const out = []
  lay.nodes.forEach((n, ni) => {
    if (n.unused || (n.kind !== 'roof' && n.kind !== 'walk')) return
    const rng = mulberry32(lay.seed * 5003 + ni), s = n.sec
    if (n.kind === 'walk') {
      // The walk runs v -1.25..1.26 across the wall's centre line (inner side +v); its outer parapet is at -1.25.
      const alongX = s.axis === 'x', inn = alongX ? s.inner[1] : s.inner[0]
      const a0 = alongX ? lay.X(s.x0) : lay.Z(s.z0), a1 = alongX ? lay.X(s.x0 + s.w) : lay.Z(s.z0 + s.d)
      const cc = (alongX ? lay.Z(s.z0) : lay.X(s.x0)) + C / 2
      for (let a = a0 + 2.5; a < a1 - 2.5; a += 2.4) {
        if (rng() > 0.45) continue
        const kind = ['stones', 'arrows', 'barrel', 'brazier'][Math.floor(rng() * 4)], [w, d] = PROP[kind], v = cc + inn * (-1.25 + d / 2 + 0.08)
        out.push({ kind, x: alongX ? a : v, y: 2 * H, z: alongX ? v : a, yaw: alongX ? (inn > 0 ? 0 : Math.PI) : inn * Math.PI / 2, w, d })
      }
      return
    }
    const y = s.floors * H, m = 0.6
    const r = [lay.X(s.x0) + m, lay.Z(s.z0) + m, lay.X(s.x0 + s.w) - m, lay.Z(s.z0 + s.d) - m], cx = (r[0] + r[2]) / 2, cz = (r[1] + r[3]) / 2
    const portals = s.round ? [] : [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]]
    for (const e of lay.edges) {
      if (e.a !== n && e.b !== n) continue
      const pts = []
      for (const d of e.doors) if (Math.abs(d.y - y) < 0.1) pts.push([d.x, d.z])
      if (e.kind === 'step') pts.push([e.pts[1][0], e.pts[1][2]])
      if (e.ladder) pts.push([e.ladder.x, e.ladder.z])
      for (const [x, z] of pts) {
        const l = Math.hypot(cx - x, cz - z) || 1
        portals.push([x, z], [x + (cx - x) / l * 1.2, z + (cz - z) / l * 1.2])
      }
    }
    const list = []
    fillKit(rng, s.round ? [cx - (s.w * C / 2 - m), cz - (s.w * C / 2 - m), cx + (s.w * C / 2 - m), cz + (s.w * C / 2 - m)] : r, s.round, portals, { must: ['brazier'], wall: ROOF_KINDS }, y, list)
    out.push(...list)
  })
  return out
}

/** Every chamber's props, in interior metres; each record also carries its storey `k`. */
export function roomProps(lay) {
  const out = []
  roomPlan(lay).chambers.forEach((c, ci) => {
    const rng = mulberry32(lay.seed * 4099 + ci), y = c.k * SH, kit = KIT[c.role], list = []
    if (c.role === 'throne') throneRoom(rng, c, y, list)
    fillKit(rng, c.rect, c.round, c.portals, kit, y, list)
    if (kit.ware) setTables(rng, list)
    const [cx, cz] = [(c.rect[0] + c.rect[2]) / 2, (c.rect[1] + c.rect[3]) / 2]
    if (kit.rug && !c.round && !list.some((o) => Math.hypot(o.x - cx, o.z - cz) < 1.6)) list.push({ kind: 'rug', x: cx, y, z: cz, yaw: c.rect[2] - c.rect[0] >= c.rect[3] - c.rect[1] ? 0 : Math.PI / 2, w: 2.4, d: 1.6 })
    if (kit.chandelier) list.push({ kind: 'chandelier', x: cx, y, z: cz, yaw: 0, w: 1.2, d: 1.2 })
    let torches = 0
    for (const o of list) if (!TORCHES.has(o.kind) || ++torches <= MAX_TORCHES) out.push({ ...o, k: c.k })
  })
  return out
}

/** The throne hall's dais against a wall clear of its portals, the throne on it, a carpet running out from it and chandeliers over
 * that, into `list`. */
function throneRoom(rng, c, y, list) {
  fillRect(rng, c.rect, c.round, c.portals, ['dais'], y, null, list, 1)
  const dais = list[0]
  if (!dais) return
  const [tx, tz] = frame(dais, 0, -0.25)
  list.push({ kind: 'throne', x: tx, y: y + 0.3, z: tz, yaw: dais.yaw, w: 1.0, d: 0.9 })
  // The carpet from the dais's front to 1 m short of the far wall.
  const [r0, r1, r2, r3] = c.rect, fx = Math.sin(dais.yaw), fz = Math.cos(dais.yaw)
  const reach = Math.abs(fx) > 0.5 ? (fx > 0 ? r2 - dais.x : dais.x - r0) : (fz > 0 ? r3 - dais.z : dais.z - r1)
  const L = reach - dais.d / 2 - 1
  if (L < 2) return
  const [cx, cz] = frame(dais, 0, dais.d / 2 + L / 2)
  list.push({ kind: 'carpet', x: cx, y, z: cz, yaw: dais.yaw, w: 1.4, d: L })
  for (let i = 0; i < (L > 8 ? 2 : 1); i++) {
    const [hx, hz] = frame(dais, 0, dais.d / 2 + L * (L > 8 ? 0.3 + i * 0.4 : 0.5))
    list.push({ kind: 'chandelier', x: hx, y, z: hz, yaw: 0, w: 1.2, d: 1.2 })
  }
}

/** The dungeon's props (interior metres, each with k -1): sconces by its door and in some rooms, stores against the rock of its dry
 * rooms, and a chest in the room the plan picked. */
export function dungeonProps(lay) {
  const g = dungeonPlan(lay), rng = mulberry32(lay.seed * 3307 + 9), out = []
  const rock = (x, z) => { const c = dungeonCell(g, x, z); return c < 0 || Number.isNaN(g.lo[c]) }
  const floorAt = (x, z) => g.lo[dungeonCell(g, x, z)]
  // A sconce on the wall through (x, z) facing inward normal (nx, nz).
  const sconce = (x, z, nx, nz) => {
    if (!rock(x - nx * 0.5, z - nz * 0.5) || rock(x + nx * 0.5, z + nz * 0.5)) return false
    const [w, d] = PROP.sconce, o = d / 2 + 0.05
    out.push({ kind: 'sconce', x: x + nx * o, y: floorAt(x + nx * 0.5, z + nz * 0.5), z: z + nz * o, yaw: Math.atan2(nx, nz), w, d, k: -1 })
    return true
  }
  // Either side of the door inside the foot chamber, and on the passage wall just past it.
  const { door } = g, [ax, az] = door.axis === 'x' ? [1, 0] : [0, 1], [lx, lz] = [az, ax]
  const face = [door.x - ax * door.side * 0.5, door.z - az * door.side * 0.5]
  sconce(face[0] + lx * 2.5, face[1] + lz * 2.5, -ax * door.side, -az * door.side)
  const past = [door.x + ax * door.side, door.z + az * door.side]
  if (!sconce(past[0] + lx * door.hw, past[1] + lz * door.hw, -lx, -lz)) sconce(past[0] - lx * door.hw, past[1] - lz * door.hw, lx, lz)
  g.rooms.forEach((r, ri) => {
    const [x0, z0, x1, z1] = r.rect
    if (r.hi - r.lo >= 3 && (ri === g.chest || rng() < 0.35)) for (let t = 0; t < 8; t++) {
      const side = Math.floor(rng() * 4), u = Math.floor(rng() * (side < 2 ? x1 - x0 : z1 - z0)) + 0.5
      const [x, z, nx, nz] = side === 0 ? [x0 + u, z0, 0, 1] : side === 1 ? [x0 + u, z1, 0, -1] : side === 2 ? [x0, z0 + u, 1, 0] : [x1, z0 + u, -1, 0]
      if (sconce(x, z, nx, nz)) break
    }
    if (r.junction || r.flooded || x1 - x0 < 3 || z1 - z0 < 3) return
    // What stands here keeps its back to rock and all its feet on the room's floor, off the gutter.
    const keep = (o) => rock(...frame(o, 0, -o.d / 2 - 0.3)) && cornersOf(o.x, o.z, o.yaw, o.w, o.d).every(([x, z]) => !rock(x, z) && Math.abs(floorAt(x, z) - r.lo) < 1e-4)
    const list = []
    // The chest keeps clear of the room's ways through where it can, else stands anywhere against its rock.
    if (ri === g.chest) for (let t = 0; t < 80 && !list.length; t++) {
      fillRect(rng, r.rect, false, t < 40 ? r.portals : [], ['chest'], r.lo, null, list, 1)
      if (list.length && !keep(list[0])) list.length = 0
    }
    if (ri === g.chest && !list.length) throw new Error(`castle ${lay.seed}: no wall for the dungeon chest`)
    fillRect(rng, r.rect, false, r.portals, DUNGEON_KINDS, r.lo, null, list)
    fillRect(rng, r.rect, false, r.portals, DUNGEON_KINDS, r.lo, null, list)
    for (const o of list) if (o.kind === 'chest' || keep(o)) out.push({ ...o, k: -1 })
  })
  return out
}

/** The chamber the dungeon's key lies in, and the roll that picked it, which keySpot goes on drawing from: the throne room most
 * often, else the treasury, else the bedchamber. */
export function keyChamber(lay) {
  const rng = mulberry32(lay.seed * 4421 + 7), { chambers } = roomPlan(lay)
  const order = rng() < 0.7 ? ['throne', 'treasury', 'bedchamber'] : ['treasury', 'bedchamber', 'throne']
  const c = order.map((role) => chambers.find((q) => q.role === role)).find((q) => q !== undefined)
  if (c === undefined) throw new Error(`castle ${lay.seed}: no throne room, treasury or bedchamber for the key`)
  return { c, rng }
}

/** Where the dungeon's key lies (interior metres, unwarped): on a chest or a table in keyChamber's room; on its floor when nothing
 * there has a top. */
export function keySpot(lay) {
  const { c, rng } = keyChamber(lay), [x0, z0, x1, z1] = c.rect, y = c.k * SH
  const tops = roomProps(lay).filter((o) => o.k === c.k && o.y === y && o.x > x0 && o.x < x1 && o.z > z0 && o.z < z1 && (o.kind === 'chest' || o.kind in SURFACE))
  if (tops.length) {
    const o = tops[Math.floor(rng() * tops.length)]
    return [o.x, o.y + (o.kind === 'chest' ? 0.6 : SURFACE[o.kind]), o.z]
  }
  return [(x0 + x1) / 2 + 0.8, y, (z0 + z1) / 2]
}
