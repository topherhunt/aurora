// One cave system from its seed and mouths: the graph, the field, the props and the lights the mesher bakes. Pure, so the worker and the main thread each plan the same cave (design/39-caves.md §4).

import { buildGraph } from './graph.js'
import { CaveField } from './field.js'
import { placeProps, columnAt } from './props.js'
import { waterBodies } from './walk.js'

// The daylight leaking in at a mouth: a light every DAY_STEP metres in from it, fading to nothing by DAY_M, so the way out reads from down the passage.
const DAYLIGHT = { color: [0.55, 0.6, 0.7], reach: 6, power: 0.8 }
const DAY_M = 11
const DAY_STEP = 2.5
// A cellar's (an entry with `cellar` set): the house's candlelight down its stair.
const LAMPLIGHT = { color: [0.9, 0.55, 0.25], reach: 8, power: 0.6 }
// Metres in from the mouth node she arrives, and how near it she must come to leave.
export const ARRIVE_IN = 3.5
export const EXIT_R = 1.6

/** `entries` as buildGraph takes them. Returns { graph, field, props, lights, waters, doors }, doors[e] being { x, y, z, dx, dz } at mouth e's arrival spot facing in. */
export function planCave({ seed, entries }) {
  const graph = buildGraph({ seed, entries })
  const field = new CaveField(graph, seed)
  const props = placeProps(graph, field, seed)
  const lights = [...props.lights]
  const doors = []
  for (const n of graph.nodes) {
    if (n.kind !== 'mouth') continue
    const { dx, dz, cellar } = entries[n.entry]
    if (cellar) lights.push({ x: n.x - dx * 0.6, y: n.y + 1.4, z: n.z - dz * 0.6, ...LAMPLIGHT })
    else {
      for (let d = -0.6; d < DAY_M; d += DAY_STEP) {
        const x = n.x + dx * d, z = n.z + dz * d
        const col = columnAt(field, x, z, n.y + 1.4)
        if (col === null) continue
        const fade = (1 - Math.max(0, d) / DAY_M) ** 2
        lights.push({ x, y: Math.min(col.floor + 1.6, col.roof - 0.3), z, ...DAYLIGHT, power: DAYLIGHT.power * fade })
      }
    }
    const x = n.x + dx * ARRIVE_IN, z = n.z + dz * ARRIVE_IN
    const col = columnAt(field, x, z, n.y + 1.2)
    if (col === null) throw new Error(`planCave: mouth ${n.entry}'s arrival spot is in rock`)
    doors[n.entry] = { node: n.i, x, y: col.floor, z, dx, dz, mx: n.x, my: n.y, mz: n.z }
  }
  return { graph, field, props, lights, waters: waterBodies(graph), doors }
}
