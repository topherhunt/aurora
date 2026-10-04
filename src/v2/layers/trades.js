// The towns' trades (DESIGN.md §32 Trades), three-free: who lives in a town, at most one of each avatar so a name points at one face, and the works their trades stand in. layers/towns.js lays the works out, render/trades.js draws them, townsfolk.js walks the folk through them.

export const TRADES = {
  // The avatars (public/creatures/<id>.glb), one of each at most to a town.
  bodies: ['blacksmith', 'alchemist', 'innkeeper', 'farmer', 'shepherd', 'woodcutter', 'hunter', 'miner', 'fisherman'],
  // Folk a town holds: never every body, so a traveller arriving is never a second of anyone.
  folk: [6, 7],
  // Open-sided under a tile roof, its front (+Z) on the clearing's edge; the floor may fall `range` m.
  smithy: { w: 7, d: 5, post: 2.5, rise: 1.5, over: 0.45, range: 1.0, tries: 240 },
  // A second farm with chance `two`. The farmhouse rings the town `out` m past the buildings.
  farm: { two: 0.6, out: 4, keep: 16 },
  // The field: a w x d quad rolled square, trapezoid or cut-corner, its ground falling at most `range`; carrot rows `row` apart, `inset` in from the fence, carrots `step` along them; fence posts at most `post` apart, rails at `rails` m, the gate `gate` m wide.
  field: { w: [9, 13], d: [7, 10], jitter: 1.0, range: 2.5, row: 0.8, inset: 0.7, step: 0.4, post: 2.2, rails: [0.45, 0.85], gate: 1.4, gap: 1.0 },
  shed: { w: 3.2, d: 2.4, range: 0.8 },
  // The chopping stump `stump` m out from the pile's middle, the woodcutter `stand` m further out.
  woodpile: { w: 2.6, d: 1.0, stump: 1.4, stand: 0.65 },
}

export const SMITHY_ANVILS = [[[-1.3, 0.6]], [[-1.6, 0.6], [1.5, 0.9]]]

/** A smithy's furniture in its own frame (metres, floor at 0, front +Z): where each piece stands and where the smith stands to work it, facing `h` (local yaw, 0 facing +Z). */
export function smithyLayout(anvils) {
  const { w, d } = TRADES.smithy
  const forge = { x: 0, z: -d / 2 + 0.85, w: 1.9, d: 1.3, h: 1.0 }
  const mouthZ = forge.z + forge.d / 2
  const tub = { x: w / 2 - 0.9, z: -d / 2 + 1.0, r: 0.42 }
  return {
    forge,
    // Where the forge's flame stands: in the hood's mouth, on the hearth.
    fire: [0, forge.h + 0.03, mouthZ - 0.12],
    anvils: SMITHY_ANVILS[anvils - 1].map(([x, z]) => ({ x, z })),
    tub,
    posts: [-1, 1].flatMap((sx) => [[sx * (w / 2 - 0.15), d / 2 - 0.15], [sx * (w / 2 - 0.15), -d / 2 + 0.15], [sx * 1.75, -d / 2 + 0.15], [sx * 1.75, d / 2 - 0.15]]),
    stand: {
      forge: { x: 0, z: mouthZ + 0.5, h: Math.PI },
      anvil: SMITHY_ANVILS[anvils - 1].map(([x, z]) => ({ x, z: z - 0.62, h: 0 })),
      tub: { x: tub.x - 0.8, z: tub.z, h: Math.PI / 2 },
    },
    entry: { x: 0, z: d / 2 + 0.9 },
  }
}

/** Local (lx, lz) of a frame at (x, z) turned `yaw` to the world, local +Z toward (sin yaw, cos yaw). */
export const toWorld = (x, z, yaw, lx, lz) => {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  return [x + lx * c + lz * s, z - lx * s + lz * c]
}

/** A field's outline in its own frame, convex and counter-clockwise seen from above: square, trapezoid or a rectangle with a corner cut. */
export function fieldOutline(rand) {
  const F = TRADES.field
  const shape = rand()
  let w = F.w[0] + rand() * (F.w[1] - F.w[0])
  let d = F.d[0] + rand() * (F.d[1] - F.d[0])
  if (shape < 0.3) w = d = (w + d) / 2
  const j = () => (rand() - 0.5) * F.jitter
  const pts = [[-w / 2 + j(), d / 2 + j()], [w / 2 + j(), d / 2 + j()], [w / 2 + j(), -d / 2 + j()], [-w / 2 + j(), -d / 2 + j()]]
  if (shape >= 0.3 && shape < 0.65) {
    const pinch = w * (0.12 + rand() * 0.12)
    pts[2][0] -= pinch
    pts[3][0] += pinch
  } else if (shape >= 0.65) {
    const k = (rand() * 4) | 0
    const a = pts[k], b = pts[(k + 1) % 4], z = pts[(k + 3) % 4], f = 0.25 + rand() * 0.15
    pts.splice(k, 1, [a[0] + (z[0] - a[0]) * f, a[1] + (z[1] - a[1]) * f], [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f])
  }
  return pts
}

/** The x-span of convex outline `pts` along z = `z`, or null where it misses. */
function spanAt(pts, z) {
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < pts.length; i++) {
    const [ax, az] = pts[i]
    const [bx, bz] = pts[(i + 1) % pts.length]
    if ((az - z) * (bz - z) > 0 || az === bz) continue
    const x = ax + ((z - az) / (bz - az)) * (bx - ax)
    lo = Math.min(lo, x)
    hi = Math.max(hi, x)
  }
  return lo < hi ? [lo, hi] : null
}

/** The carrot rows of an outline, each `{ z, x0, x1 }` in its frame, `inset` clear of every edge. */
export function fieldRows(pts) {
  const F = TRADES.field
  const zs = pts.map((p) => p[1])
  const rows = []
  for (let z = Math.min(...zs) + F.inset; z <= Math.max(...zs) - F.inset; z += F.row) {
    const a = spanAt(pts, z - F.inset), b = spanAt(pts, z + F.inset), c = spanAt(pts, z)
    if (!a || !b || !c) continue
    const x0 = Math.max(a[0], b[0], c[0]) + F.inset, x1 = Math.min(a[1], b[1], c[1]) - F.inset
    if (x1 - x0 > 1) rows.push({ z, x0, x1 })
  }
  return rows
}

/** The fence round an outline as runs of `[x, z]` posts, broken for the gate centred on edge `gate`. */
export function fenceRuns(pts, gate) {
  const F = TRADES.field
  const runs = []
  for (let i = 0; i < pts.length; i++) {
    const [ax, az] = pts[i]
    const [bx, bz] = pts[(i + 1) % pts.length]
    const len = Math.hypot(bx - ax, bz - az)
    const at = (s) => [ax + ((bx - ax) * s) / len, az + ((bz - az) * s) / len]
    const line = (s0, s1) => {
      const n = Math.max(1, Math.ceil((s1 - s0) / F.post))
      runs.push(Array.from({ length: n + 1 }, (_, k) => at(s0 + ((s1 - s0) * k) / n)))
    }
    if (i !== gate) { line(0, len); continue }
    line(0, len / 2 - F.gate / 2)
    line(len / 2 + F.gate / 2, len)
  }
  return runs
}

/** Who lives in a town: `[{ body, trade, home, work }]`, one of each body at most, `home` a building index and `work` a works index or null. The smith, potion master, innkeeper and farmers take their places when the town has them; the rest fill free houses up to TRADES.folk. A smith whose home found no seat takes a free house. */
export function castFolk(rand, { smithy, potions, inn, farms, free }) {
  const folk = []
  const houses = [...free]
  const house = () => (houses.length === 0 ? -1 : houses.splice((rand() * houses.length) | 0, 1)[0])
  const add = (body, trade, home, work = null) => {
    if (home >= 0) folk.push({ body, trade, home, work })
  }
  if (smithy !== null) add('blacksmith', 'smith', smithy.home >= 0 ? smithy.home : house(), smithy.work)
  if (potions >= 0) add('alchemist', 'potions', potions)
  if (inn >= 0) add('innkeeper', 'inn', inn)
  farms.forEach((f, i) => add(['farmer', 'shepherd'][i], 'farm', f.home, f.field))
  const cast = new Set(folk.map((f) => f.body))
  // The trades a town lacks leave their bodies out: no smith without a smithy.
  const spare = TRADES.bodies.filter((b) => !cast.has(b) && !['blacksmith', 'alchemist', 'innkeeper', 'farmer'].includes(b))
  const want = TRADES.folk[0] + ((rand() * (TRADES.folk[1] - TRADES.folk[0] + 1)) | 0)
  while (folk.length < want && spare.length > 0) {
    const home = house()
    if (home < 0) break
    folk.push({ body: spare.splice((rand() * spare.length) | 0, 1)[0], trade: null, home, work: null })
  }
  return folk
}
