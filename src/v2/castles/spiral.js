// A castle's spiral shafts (design/44-castles.md, Spiral shafts) in interior metres, shared by the shell, the collision and the
// furnishing. layout.js planShafts picks each helix's hand, starts, landings and doorways; this gives them their geometry.
import { CASTLE } from './layout.js'
import { dungeonPlan } from './dungeon.js'

const S = CASTLE.scale, V = CASTLE.tall, SH = CASTLE.storey * V
export const SEG = Math.PI / 8
// 15 segments of 1/16 turn round a post, each `treads` steps, the 16th its landing in the storey above. A drum `wall` thick walls
// the steps at `well` on every storey of the shaft, open `door` high at each doorway. `square` is the half side of the slab square
// cut round each well. A post no spiral climbs on from ends in a finial `cap` tall.
export const SPIRAL = { well: 1.75, wall: 0.12, square: 2.1, post: 0.3, steps: 15, treads: 2, door: 2.8, cap: 1.3 }
// Stone fills a shaft storey's cell round its drum out to `box` (half a partition past the cell line). A doorway's tunnel runs from
// the drum to a door's reveal at `reveal`, or `room` wide each side and `roomH` high to the box's face onto the rest of the room,
// which stands as a partition from `partition` out, or as wide and high to the cell line, where a link meets the drum beside's.
export const SHAFT = { box: 4.2, reveal: 2.95, room: 1.2, roomH: 3, partition: 3.8 }
const SIDES = [[1, 0], [0, 1], [-1, 0], [0, -1]]

/** Segment (0-15) of bearing a, counted from a0 the way hand `hand` climbs. */
export const segmentOf = (a, a0, hand) => Math.floor((((hand * (a - a0)) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / SEG) % 16

const memo = new WeakMap()
/**
 * Every shaft as interior-metre records: `flights` { k, x, z, a0, hand, last } and `storeys` { k, y, role, node, gx, gz, x, z,
 * exits, hole, spur, same, open }, plus `sealed`, the keys `gx,gz,k` of the cells they fill. An exit is { c, o, kind, w0, w1,
 * jamb, h, quads }: the doorway centred on segment o of the drum and its tunnel to face c, lateral w0..w1 at the jamb, h high;
 * quads are its plan, convex, drum to jamb and (short of the box) jamb on out past it. `hole` { a0, hand, lo } is the slab's
 * opening over the arriving flight's segments lo-14; `spur` walls its first edge where the helix ends. same[c] / open[c]: the cell across face c is of the same room / of it and unsealed.
 */
export function shaftsOf(lay) {
  if (memo.has(lay)) return memo.get(lay)
  const flights = [], storeys = [], sealed = new Set()
  for (const sh of lay.shafts) for (const st of sh.storeys) sealed.add(`${sh.gx},${sh.gz},${st.k}`)
  const R1 = SPIRAL.well + SPIRAL.wall
  for (const sh of lay.shafts) {
    const x = sh.x * S, z = sh.z * S, { hand } = sh
    sh.flights.forEach((f, i) => flights.push({ k: f.k, x, z, a0: f.s * SEG, hand, last: i === sh.flights.length - 1 }))
    sh.storeys.forEach((st, i) => {
      const y = st.k * SH, arriving = st.role === 'bottom' ? null : sh.flights[i - 1]
      const same = SIDES.map(([sx, sz]) => st.node !== null && contains(st.node, sh.gx + sx, sh.gz + sz))
      const open = same.map((v, c) => v && !sealed.has(`${sh.gx + SIDES[c][0]},${sh.gz + SIDES[c][1]},${st.k}`))
      const exits = st.exits.map((ex) => {
        const [nx, nz] = SIDES[ex.c], tx = -nz, tz = nx, pt = (u, w) => [x + nx * u + tx * w, z + nz * u + tz * w]
        const lat = (px, pz) => (px - x) * tx + (pz - z) * tz
        let w0, w1, jamb, h
        if (ex.kind === 'room') [w0, w1, jamb, h] = [-SHAFT.room, SHAFT.room, SHAFT.box, SHAFT.roomH]
        else if (ex.kind === 'link') [w0, w1, jamb, h] = [-SHAFT.room, SHAFT.room, CASTLE.cell / 2 * S, SHAFT.roomH]
        else if (st.node === null) {
          const d = dungeonPlan(lay).door, w = lat(d.x, d.z)
          ;[w0, w1, jamb, h] = [w - d.hw, w + d.hw, 4, d.hi - d.lo]
        } else {
          w0 = Math.min(...ex.doors.map((d) => lat(d.x * S, d.z * S) - d.w * S / 2)); w1 = Math.max(...ex.doors.map((d) => lat(d.x * S, d.z * S) + d.w * S / 2))
          ;[jamb, h] = [SHAFT.reveal, Math.max(...ex.doors.map((d) => d.h * V))]
        }
        const ring = (a) => [x + Math.cos(a) * R1, z + Math.sin(a) * R1], far = SHAFT.box + 0.05
        const tunnel = [ring((ex.o - 1) * SEG), pt(jamb, w0), pt(jamb, w1), ring((ex.o + 1) * SEG)]
        const turns = tunnel.map((p, i) => { const q = tunnel[(i + 1) % 4], r = tunnel[(i + 2) % 4]; return (q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]) })
        if (!turns.every((t) => t > 1e-6)) throw new Error(`castle ${lay.seed}: the tunnel from cell ${sh.gx},${sh.gz}'s drum to its doorway on storey ${st.k} is not convex`)
        const quads = jamb < far ? [tunnel, [pt(jamb, w0), pt(far, w0), pt(far, w1), pt(jamb, w1)]] : [tunnel]
        return { c: ex.c, o: ex.o, kind: ex.kind, w0, w1, jamb, h, quads }
      })
      const hole = arriving && { a0: arriving.s * SEG, hand, lo: st.role === 'top' ? 8 : Math.max(7, arriving.L - 1) }
      storeys.push({ k: st.k, y, role: st.role, node: st.node, gx: sh.gx, gz: sh.gz, x, z, exits, hole, spur: st.role === 'top', same, open })
    })
  }
  const out = { flights, storeys, sealed }
  memo.set(lay, out)
  return out
}

const contains = (n, gx, gz) => gx >= n.x0 && gx < n.x0 + n.w && gz >= n.z0 && gz < n.z0 + n.d
