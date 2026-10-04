// One cave system from its seed and mouths: the graph, the field, the props and the lights the mesher bakes. Pure, so the worker and the main thread each plan the same cave (design/39-caves.md §4).

import { buildGraph } from './graph.js'
import { CaveField } from './field.js'
import { placeProps, columnAt } from './props.js'
import { waterBodies } from './walk.js'

// The daylight a mouth's dead end glows with, so the way out reads from down the passage.
const DAYLIGHT = { color: [0.55, 0.6, 0.7], reach: 9, power: 0.55 }
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
    const { dx, dz } = entries[n.entry]
    lights.push({ x: n.x - dx * 0.6, y: n.y + 1.4, z: n.z - dz * 0.6, ...DAYLIGHT })
    const x = n.x + dx * ARRIVE_IN, z = n.z + dz * ARRIVE_IN
    const col = columnAt(field, x, z, n.y + 1.2)
    if (col === null) throw new Error(`planCave: mouth ${n.entry}'s arrival spot is in rock`)
    doors[n.entry] = { node: n.i, x, y: col.floor, z, dx, dz, mx: n.x, my: n.y, mz: n.z }
  }
  return { graph, field, props, lights, waters: waterBodies(graph), doors }
}
