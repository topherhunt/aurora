// Town names (DESIGN.md §35): a Nordic prefix and suffix, each drawn from what the town stands near where it can be. Three-free and a pure function of the ground, the layers and the seed, so every client names the towns alike.
import { mulberry32 } from '../../sim/mathx.js'
import { hash32 } from '../../sim/score.js'
import { WORLD_HALF } from '../config.js'

// Suffixes by the feature they name, strongest feature first; `plain` is what a town with nothing near takes.
const SUFFIX = {
  sea: ['vik', 'fjord', 'nes', 'strand', 'havn', 'øy', 'sund'],
  lake: ['vatn', 'sjø', 'tjern', 'vann', 'holm'],
  river: ['å', 'elv', 'bekk', 'foss', 'os', 'ford'],
  snow: ['fjell', 'tind', 'bre', 'kam', 'nut'],
  cliff: ['berg', 'stein', 'klett', 'hammar', 'haug', 'rud'],
  valley: ['dal', 'botn', 'li', 'vang', 'mo'],
  plain: ['by', 'heim', 'stad', 'gard', 'torp', 'lund', 'skog', 'set', 'land'],
}
const PREFIX = {
  sea: ['Sel', 'Måse', 'Skarv', 'Salt', 'Hval', 'Tang', 'Ran'],
  lake: ['Laks', 'Siv', 'Ør', 'Svane', 'Blank', 'Stille'],
  river: ['Laks', 'Ør', 'Straum', 'Kvern', 'Bru', 'Ål'],
  snow: ['Kvit', 'Frost', 'Is', 'Snø', 'Kald', 'Vinter'],
  cliff: ['Grå', 'Stein', 'Ravn', 'Ørn', 'Bratt', 'Svart'],
  valley: ['Djup', 'Lang', 'Gran', 'Myr', 'Skygge', 'Hol'],
  plain: ['Ask', 'Birk', 'Eik', 'Alm', 'Ulv', 'Bjørn', 'Hjort', 'Rød', 'Sol', 'Tor', 'Frey', 'Grim', 'Hald', 'Skjold', 'Sig', 'Odd', 'Rune', 'Norr', 'Sør', 'Vest', 'Øst', 'Stor', 'Lille', 'Bred', 'Fager', 'Heid', 'Gull', 'Rå'],
}
// How far each feature is looked for, in metres; a cliff is ground past `cliffSlope`, snow is the town above the snow line, a valley is ground sunk `valleyDepth` under the ring at `valleyR`.
const NEAR = { water: [60, 120, 200, 300], cliff: [60, 120, 180], cliffSlope: 1.2, valleyR: 400, valleyDepth: 35 }

// The features a town stands near, strongest first, then 'plain'.
function features(t, ground, layers, seaLevels) {
  const out = []
  const ring = (radii, f) => radii.some((r) => Array.from({ length: 12 }, (_, k) => (k / 12) * Math.PI * 2).some((a) => f(t.x + Math.cos(a) * r, t.z + Math.sin(a) * r)))
  const lakeWet = (x, z) => {
    const level = layers.lakes.levelAt(x, z)
    return level !== null && ground(x, z) < level ? level : null
  }
  if (ring(NEAR.water, (x, z) => { const l = lakeWet(x, z); return l !== null && seaLevels.includes(l) })) out.push('sea')
  if (ring(NEAR.water, (x, z) => { const l = lakeWet(x, z); return l !== null && !seaLevels.includes(l) })) out.push('lake')
  if (ring(NEAR.water, (x, z) => layers.paths.riverLevelAt(x, z) !== null)) out.push('river')
  if (t.y > layers.snow.base) out.push('snow')
  const slope = (x, z) => Math.hypot(ground(x + 4, z) - ground(x - 4, z), ground(x, z + 4) - ground(x, z - 4)) / 8
  if (ring(NEAR.cliff, (x, z) => slope(x, z) > NEAR.cliffSlope)) out.push('cliff')
  let rim = 0
  for (let k = 0; k < 16; k++) rim += ground(t.x + Math.cos((k / 16) * Math.PI * 2) * NEAR.valleyR, t.z + Math.sin((k / 16) * Math.PI * 2) * NEAR.valleyR)
  if (rim / 16 - ground(t.x, t.z) > NEAR.valleyDepth) out.push('valley')
  out.push('plain')
  return out
}

// Joins prefix and suffix, dropping a letter where three alike would meet ("Hall" + "land" is "Halland").
function join(prefix, suffix) {
  const a = prefix.at(-1).toLowerCase()
  if (a === suffix[0] && a === prefix.at(-2)?.toLowerCase()) return prefix + suffix.slice(1)
  return prefix + suffix
}

// Sets `t.name` on every town, each unique. The suffix names the strongest feature the town has; the prefix is from another of its features half the time, else from `plain`.
export function nameTowns(towns, { ground, layers, seed }) {
  const seaLevels = layers.lakes.toJSON().filter((l) => Math.max(l.rx, l.rz) >= WORLD_HALF).map((l) => l.y)
  const used = new Set()
  for (const t of towns) {
    const rand = mulberry32(hash32(seed, 4409, Math.round(t.x), Math.round(t.z)))
    const pick = (list) => list[Math.floor(rand() * list.length)]
    const f = features(t, ground, layers, seaLevels)
    let name = null
    for (let tries = 0; tries < 200 && name === null; tries++) {
      // Later tries widen: any of the town's features for the suffix, then any prefix at all.
      const sf = tries < 20 ? f[0] : pick(f)
      const pf = rand() < 0.5 && f.length > 1 ? pick(f) : 'plain'
      const prefix = tries < 100 ? pick(PREFIX[pf]) : pick(Object.values(PREFIX).flat())
      const suffix = pick(SUFFIX[sf])
      const n = join(prefix, suffix)
      if (!used.has(n) && prefix.toLowerCase() !== suffix) name = n
    }
    if (name === null) throw new Error(`nameTowns: no unique name left for ${t.id}`)
    used.add(name)
    t.name = name
    t.features = f
  }
}
