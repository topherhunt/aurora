// How castle folk point the way (design/44-castles.md §Garrison, Ways): a route over a layout's walkable edges, from the node they
// stand in to a room role, the summit, the court, the gate or a town, said in at most MAX_STEPS spoken steps. Three-free.

import { compass, band } from './world.js'
import { roomPlan, courtProps } from '../castles/furnish.js'
import { CASTLE } from '../castles/layout.js'

export const WAYS = { maxSteps: 3, hopM: 5 }

const ROLE = {
  throne: 'the throne room', hall: 'the hall and kitchen', pantry: 'the pantry', guard: 'the guardroom', passage: 'the gate passage', armoury: 'the armoury', barracks: 'the barracks',
  bedchamber: 'a bedchamber', chapel: 'the chapel', maproom: 'the map room', infirmary: 'the infirmary', treasury: 'the treasury', library: 'the library', cellar: 'the cellar',
  bakehouse: 'the bakehouse', workshop: 'the workshop', store: 'a storeroom', granary: 'the granary', scullery: 'the scullery', woodstore: 'the wood store', servants: "the servants' quarters",
  guest: 'a guest chamber', linen: 'the linen room', study: 'the study', sewing: 'the sewing room', watch: 'the watch room', arsenal: 'the arsenal',
}
// The rooms she may ask the way to, each by the role its chamber has.
export const ASKED = ['throne', 'hall', 'chapel', 'library', 'bedchamber']
const COUNT = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']
const FLOOR = ['the ground floor', 'one floor up', 'two floors up', 'three floors up', 'four floors up', 'five floors up', 'six floors up', 'seven floors up']
const VIA = { stair: 'stair', ladder: 'ladder', outstair: 'steps', step: 'steps' }
const SECTION = { keep: 'the keep', gate: 'the gatehouse', hall: 'the hall wing', lookout: 'the lookout' }

/** The role's name with its article: 'the throne room'. */
export function roleName(role) {
  if (ROLE[role] === undefined) throw new Error(`castle-ways: no name for role ${role}`)
  return ROLE[role]
}

/** Castle-local vector (dx, dz) as a compass word for a site turned by `yaw`; north is -z in the world (toWorld, layers/castles.js). */
export function bearing(yaw, dx, dz) {
  return compass(dx * Math.cos(yaw) + dz * Math.sin(yaw), -dx * Math.sin(yaw) + dz * Math.cos(yaw)).replace(/^(north|south)(east|west)$/, '$1-$2')
}

/** The section node `n` is in, as a name: 'the keep', 'the north-east tower', 'the south wall'. */
export function sectionName(yaw, n) {
  if (n.kind === 'court') return 'the court'
  if (n.kind === 'entry') return 'the road outside the gate'
  const s = n.sec, dir = bearing(yaw, n.pos[0], n.pos[2])
  if (SECTION[s.kind] !== undefined) return SECTION[s.kind]
  if (s.kind === 'wall') return `the ${dir} wall`
  if (s.kind === 'tower') return `the ${dir} tower`
  throw new Error(`castle-ways: no name for section ${s.kind}`)
}

/** Where `spec` (castle-folk.js insideCast / outsideCast) stands: `{ node, chamber }`, chamber null outdoors. */
export function standing(lay, spec) {
  if (spec.room !== undefined) return { node: spec.room.node, chamber: spec.room }
  const find = (kind) => {
    const n = lay.nodes.find((q) => q.kind === kind)
    if (n === undefined) throw new Error(`castle-ways: castle ${lay.seed} has no ${kind} node`)
    return n
  }
  if (spec.who === 'watch') return { node: lay.nodes.filter((n) => n.kind === 'walk').reduce((a, b) => (Math.hypot(b.pos[0] - spec.x, b.pos[2] - spec.z) < Math.hypot(a.pos[0] - spec.x, a.pos[2] - spec.z) ? b : a)), chamber: null }
  if (spec.who === 'lore') return { node: find('summit'), chamber: null }
  if (spec.who === 'yard') return { node: find('court'), chamber: null }
  if (spec.who === 'gate' || spec.who === 'traveller') return { node: find('entry'), chamber: null }
  throw new Error(`castle-ways: ${spec.who} stands nowhere known`)
}

/** Where she is, as `{ phrase, k }`: 'in the throne room, one floor up, in the keep' or 'on the south wall walk'. */
export function hereName(lay, yaw, at) {
  const n = at.node
  if (at.chamber !== null) return `in ${roleName(at.chamber.role)}, ${FLOOR[n.k]}, in ${sectionName(yaw, n)}`
  if (n.kind === 'walk') return `on ${sectionName(yaw, n)} walk`
  if (n.kind === 'summit') return 'on top of the lookout'
  if (n.kind === 'court') return 'in the court'
  if (n.kind === 'entry') return 'on the road outside the gate'
  throw new Error(`castle-ways: nowhere to name for a ${n.kind} node`)
}

/** The places she may ask the way to in castle `lay`: `[{ id, label, goals: Set of nodes }]`. */
export function places(lay) {
  const { chambers } = roomPlan(lay), out = []
  for (const role of ASKED) {
    const nodes = chambers.filter((c) => c.role === role).map((c) => c.node)
    if (nodes.length > 0) out.push({ id: role, label: roleName(role), goals: new Set(nodes) })
  }
  const one = (id, label, n) => out.push({ id, label, goals: new Set([n]) })
  one('dungeon', 'the dungeon door', lay.dungeon.node)
  one('summit', 'the lookout summit', lay.nodes.find((n) => n.kind === 'summit'))
  one('court', 'the court', lay.nodes.find((n) => n.kind === 'court'))
  one('gate', 'the gate', lay.nodes.find((n) => n.kind === 'entry'))
  if (courtProps(lay).some((o) => o.kind === 'well')) one('well', 'the well', lay.nodes.find((n) => n.kind === 'court'))
  return out
}

const walkable = (e) => e.kind !== 'rope' && e.kind !== 'barred'
const adjacency = new WeakMap()
function graph(lay) {
  if (!adjacency.has(lay)) {
    const adj = new Map(lay.nodes.map((n) => [n, []]))
    for (const e of lay.edges) if (walkable(e)) { adj.get(e.a).push([e.b, e]); adj.get(e.b).push([e.a, e]) }
    adjacency.set(lay, adj)
  }
  return adjacency.get(lay)
}

/** The fewest-hops walk from `from` to the nearest of `goals` with the `shut` edges barred: `{ nodes, edges }`, or null. */
export function route(lay, from, goals, shut) {
  const adj = graph(lay), via = new Map([[from, null]]), queue = [from]
  let end = goals.has(from) ? from : null
  for (let i = 0; i < queue.length && end === null; i++) for (const [q, e] of adj.get(queue[i])) {
    if (via.has(q) || shut.has(e)) continue
    via.set(q, [queue[i], e])
    if (goals.has(q)) { end = q; break }
    queue.push(q)
  }
  if (end === null) return null
  const nodes = [end], edges = []
  for (let n = end; via.get(n) !== null; n = via.get(n)[0]) { nodes.unshift(via.get(n)[0]); edges.unshift(via.get(n)[1]) }
  return { nodes, edges }
}

/** The edges of `lay` whose ward is still shut under `open`, the bitmask of opened wards (bit i is lay.wards[i]). */
export function shutEdges(lay, open) {
  return new Set(lay.wards.filter((_, i) => !(open & (1 << i))).map((w) => w.edge))
}

/**
 * A route as spoken fragments, `[{ text, floors, m }]` (`floors` signed, up positive; `m` metres along the plan): runs of storey changes
 * and runs along one level. A level run under WAYS.hopM is a doorway and goes unsaid; more than WAYS.maxSteps are cut down by
 * dropping the shortest level runs (never the bridge or the gate).
 */
export function steps(yaw, path) {
  const H = CASTLE.storey, raw = []
  path.edges.forEach((e, i) => {
    const a = path.nodes[i], b = path.nodes[i + 1], dy = b.pos[1] - a.pos[1], floors = Math.abs(dy) > 1.5 && e.kind !== 'gate' ? Math.max(1, Math.round(Math.abs(dy) / H)) * Math.sign(dy) : 0
    const last = raw.at(-1)
    if (floors !== 0) {
      if (last !== undefined && Math.sign(last.floors) === Math.sign(floors)) last.floors += floors
      else raw.push({ floors, e, a, b })
    } else if (last !== undefined && last.floors === 0) { last.b = b; last.bridge ||= e.kind === 'bridge'
      if (e.kind === 'gate') last.gate = b.kind === 'entry' ? 'out' : 'in' }
    else raw.push({ floors: 0, e, a, b, bridge: e.kind === 'bridge', gate: e.kind === 'gate' ? (b.kind === 'entry' ? 'out' : 'in') : null })
  })
  const spans = raw.filter((r) => r.floors !== 0 || Math.hypot(r.b.pos[0] - r.a.pos[0], r.b.pos[2] - r.a.pos[2]) >= WAYS.hopM || r.bridge || r.gate)
  const merged = []
  for (const r of spans) {
    const last = merged.at(-1)
    if (r.floors !== 0 && last !== undefined && Math.sign(last.floors) === Math.sign(r.floors)) last.floors += r.floors
    else merged.push({ ...r })
  }
  let list = merged.map((r) => {
    const m = Math.hypot(r.b.pos[0] - r.a.pos[0], r.b.pos[2] - r.a.pos[2])
    if (r.floors !== 0) {
      const at = [r.e.a, r.e.b].find((n) => n.kind !== 'court' && n.kind !== 'entry') ?? r.e.a, n = Math.abs(r.floors)
      return { floors: r.floors, m, text: `${r.floors > 0 ? 'up' : 'down'} ${COUNT[n - 1]} ${n === 1 ? 'floor' : 'floors'} by ${sectionName(yaw, at)} ${VIA[r.e.kind]}`, vertical: true }
    }
    const dir = bearing(yaw, r.b.pos[0] - r.a.pos[0], r.b.pos[2] - r.a.pos[2])
    const text = r.gate ? `${r.gate} through the gate` : r.bridge ? `over the bridge, heading ${dir}` : r.a.kind === 'court' ? `across the court, heading ${dir}` : r.a.kind === 'walk' ? `along ${sectionName(yaw, r.a)} walk, heading ${dir}` : `${dir} through ${sectionName(yaw, r.a)}`
    return { floors: 0, m, text, vertical: false, keep: r.bridge || r.gate !== null }
  })
  while (list.length > WAYS.maxSteps) {
    const level = list.filter((s) => !s.vertical && !s.keep)
    if (level.length === 0) { list = [...new Set([list[0], list.reduce((a, b) => (Math.abs(b.floors) > Math.abs(a.floors) ? b : a)), list.at(-1)])]; break }
    list.splice(list.indexOf(level.reduce((a, b) => (b.m < a.m ? b : a))), 1)
  }
  return list
}

/** The words for a town `to` ({ x, z }) from the castle at `from`: 'a long walk to the south-east'. */
export function townWay(from, to) {
  const dx = to.x - from.x, dz = to.z - from.z
  return `${band(Math.hypot(dx, dz))} to the ${compass(dx, dz).replace(/^(north|south)(east|west)$/, '$1-$2')}`
}
