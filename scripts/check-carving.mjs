// Node-side gates for carving a pumpkin (src/v2/render/pumpkins.js): the mask, the blade's cut, and the layers it is drawn from.
//
//   node scripts/check-carving.mjs
//
// What can go wrong without throwing: a quick stroke leaving dots, not a line; a blade through the middle cutting the far
// wall; a mask that does not survive the trip through a slot; two lanterns drawn from one layer.

import * as THREE from 'three'
import { LitterCards } from '../src/v2/render/litter-cards.js'
import { PropArena } from '../src/v2/render/prop-arena.js'
import { propCull } from '../src/v2/render/gen-props.js'
import { Pumpkins, meshReach, CARVE_W, CARVE_H, CARVE_BYTES, CARVE_B64, UNCUT, cellAt, cutSweep, rayInto, encodeCarve, decodeCarve, LANTERN, KIND, SIZE_M } from '../src/v2/render/pumpkins.js'

const R = SIZE_M / 2
let failed = 0
const check = (ok, title, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${title}${detail ? `   ${detail}` : ''}`)
  if (!ok) failed++
}
const isCut = (bits, c) => (bits[c >> 3] & (1 << (c & 7))) !== 0
const count = (bits) => bits.reduce((n, b) => { for (let i = 0; i < 8; i++) n += (b >> i) & 1; return n }, 0)
const v = (x, y, z) => new THREE.Vector3(x, y, z)

{
  const bits = new Uint8Array(CARVE_BYTES)
  for (let i = 0; i < bits.length; i++) bits[i] = (i * 37) & 255
  const b64 = encodeCarve(bits)
  check(b64.length === CARVE_B64 && decodeCarve(b64).every((b, i) => b === bits[i]), `a mask survives base64, ${CARVE_B64} characters`)
  let threw = false
  try { decodeCarve(b64.slice(4)) } catch { threw = true }
  check(threw, 'a mask of the wrong length is refused')
}

{
  const front = cellAt(0, 0, R * 0.95)
  check(front >= 0 && cellAt(0, 0, 0) === -1 && cellAt(0, 0, R * 1.5) === -1, 'only a point within the wall has a cell', `front ${front}`)
  const ix = front % CARVE_W, iy = Math.floor(front / CARVE_W)
  check(Math.abs(ix - CARVE_W * 0.75) <= 1 && Math.abs(iy - CARVE_H / 2) <= 1, 'the front of the belly is the cell three quarters round, halfway down', `(${ix}, ${iy})`)
}

{
  // A blade stabbed straight in through the front to the middle cuts the front wall, and nothing of the back.
  const bits = new Uint8Array(CARVE_BYTES)
  const n = cutSweep(bits, v(0, 0, R * 1.3), v(0, 0, 0), v(0, 0, R * 1.3), v(0, 0, 0))
  const back = cellAt(0, 0, -R * 0.95)
  check(n >= 1 && n <= 3 && isCut(bits, cellAt(0, 0, R * 0.95)) && !isCut(bits, back), 'a stab cuts the wall it passes, not the far one', `${n} cells`)
}

{
  // One frame's sweep, the blade crossing the face 12 cm sideways, cuts an unbroken line.
  const bits = new Uint8Array(CARVE_BYTES)
  const at = (x) => [v(x, 0, R * 1.2), v(x, 0, R * 0.7)]
  const [a0, b0] = at(-0.06), [a1, b1] = at(0.06)
  cutSweep(bits, a0, b0, a0, b0)
  cutSweep(bits, a0, b0, a1, b1)
  const row = Math.floor(cellAt(0, 0, R * 0.95) / CARVE_W)
  const cols = []
  for (let ix = 0; ix < CARVE_W; ix++) if (isCut(bits, row * CARVE_W + ix)) cols.push(ix)
  const gapless = cols.length > 0 && cols.every((c, i) => i === 0 || c === cols[i - 1] + 1)
  check(gapless && cols.length >= 10, 'a quick stroke across the face is one line, not dots', `${cols.length} cells, ${count(bits)} in all`)
}

{
  const hit = new THREE.Vector3()
  const ok = rayInto(v(0.01, 0.02, 2), v(0, 0, -1), hit)
  check(ok && Math.abs(hit.z - R) < 0.02 && cellAt(hit.x, hit.y, hit.z - 0.004) >= 0, 'the desk ray meets the skin at the front', `z ${hit.z.toFixed(3)}`)
  check(!rayInto(v(1, 0, 2), v(0, 0, -1), hit), 'a ray past the pumpkin meets nothing')
}

{
  const scene = new THREE.Scene()
  const p = new Pumpkins(scene, () => 0, [], new LitterCards(64))
  const whole = p.slot(KIND, 0.9, 1.1)
  const cut = new Uint8Array(CARVE_BYTES)
  cut[100] = 0b101
  const lantern = p.carved(whole, encodeCarve(cut))
  const packed = JSON.parse(JSON.stringify(lantern))
  check(packed.kind === LANTERN && packed.scale[0] === 0.9 && decodeCarve(packed.carve)[100] === 0b101, 'a carved pumpkin keeps its size and its mask through a slot')
  let threw = false
  try { p.dress({ ...packed, carve: undefined }) } catch { threw = true }
  check(threw && p.slot(LANTERN).carve === UNCUT, 'a lantern without a mask is refused; a new one is uncut')
  check(p.drawn('aLit', { lit: true })[0] === 1 && p.drawn('aLit', { lit: false })[0] === 0, 'a lantern draws its flame from rec.lit')

  // Layers: a mask each, the same mask the same layer, loaded where the shader reads it.
  p.update(0, 0, 0)
  const masks = Array.from({ length: 32 }, (_, i) => { const b = new Uint8Array(CARVE_BYTES); b[i] = 1; return encodeCarve(b) })
  const layers = masks.slice(0, 31).map((m) => p.layerOf(m))
  check(new Set(layers).size === 31 && !layers.includes(0) && p.layerOf(masks[3]) === layers[3], '31 masks drawn at once have a layer each, and keep it')
  const data = p.carveTex.image.data
  const texel = (layer, i) => data[layer * CARVE_W * CARVE_H + i]
  check(texel(layers[5], 40) === 255 && texel(layers[5], 41) === 0 && texel(layers[5], 0) === 0, "a layer holds its mask's cells", `bit 40 of mask 5`)
  check(p.layerOf(masks[31]) === 0 && p.stats.overflow === 1, 'a 32nd drawn the same frame is drawn uncut, and counted')
  p.update(0, 0, 0)
  for (const m of masks.slice(1, 31)) p.layerOf(m)
  const reused = p.layerOf(masks[31])
  check(reused === layers[0] && texel(reused, 248) === 255 && texel(reused, 0) === 0, 'next frame it takes the layer of the mask least lately drawn, reloaded')
  p.dispose()
}

{
  // Three pumpkins of scale 1 on flat ground at 2, 20 and 40 m: inside the mesh's rung, on the card's, past the cull.
  const p = new Pumpkins(new THREE.Scene(), () => 0, [{ spots: [[2, 0, 0.75], [20, 0, 0.75], [40, 0, 0.75]] }], new LitterCards(64))
  const [near, mid, far] = p.spots
  const meshR = meshReach(SIZE_M)
  const cull = propCull(SIZE_M)
  check(meshReach(SIZE_M * 0.55) >= 5 && meshReach(SIZE_M * 1.15) <= 11 && meshR > 2 && meshR < 18 && cull > 20 && cull < 40, 'the mesh holds from 5 m for the smallest to 10 m for the largest, and the rungs fall between the three', `scale 1: mesh to ${meshR.toFixed(1)} m, card to ${cull.toFixed(1)} m`)
  for (let f = 0; f < 8; f++) p.update(0, 0, 0)
  const vis = (s) => p.cards.vis[s.id]
  check(p.shown.length === 1 && p.shown[0] === near && !vis(near), 'the near pumpkin is its mesh and not its card')
  check(vis(mid) && !vis(far), 'the middle one is its card, and the far one nothing')
  check(p.pickAt(20, mid.y, 0, 0.5)?.spot === mid, 'a pumpkin on its card can still be taken')
  for (let f = 0; f < 8; f++) p.update(19, 0, 0)
  check(p.shown.length === 1 && p.shown[0] === mid && !vis(mid) && vis(near), 'walking to the middle one swaps the two')
  p.take(p.pickAt(20, mid.y, 0, 0.5))
  for (let f = 0; f < 8; f++) p.update(19, 0, 0)
  check(p.shown.length === 0 && !vis(mid) && p.tile.n === 2, 'a taken pumpkin is neither mesh nor card')

  // Dropped ones: near, the hands' mesh; far, the field's card; past the cull, nothing.
  const head = { x: 0, y: 0, z: 0 }
  const lantern = (x) => ({ rec: p.slot(LANTERN), x, y: 0.15, z: 0, q: new THREE.Quaternion() })
  const loose = [lantern(1), lantern(15), lantern(60), { rec: { kind: 'carrot' }, x: 15, y: 0, z: 0 }]
  const far2 = new Set()
  p.drawFar(loose, head, far2)
  check(!far2.has(loose[0]) && far2.has(loose[1]) && far2.has(loose[2]) && !far2.has(loose[3]), 'a dropped lantern past the mesh is left to the pumpkins, and a carrot is not theirs')
  check(p.looseShown === 1 && p.looseCards.vis[0] === 1, 'only the one inside the cull wears a card')
  far2.clear()
  p.drawFar([], head, far2)
  check(p.looseShown === 0 && p.looseCards.vis[0] === 0, 'a card is put away when its lantern is gone')
  p.setShown(false)
  check(!vis(near) && !p.mesh.visible, 'setShown(false) hides the cards and the mesh alike')
  p.dispose()
}

{
  // Seventy pumpkins all on their cards: fifty drawn, the rest refused, and nothing thrown.
  const spots = Array.from({ length: 70 }, (_, i) => [15 * Math.cos(i * 0.09), 15 * Math.sin(i * 0.09), 0.75])
  const p = new Pumpkins(new THREE.Scene(), () => 0, [{ spots }], new LitterCards(256))
  for (let f = 0; f < 8; f++) p.update(0, 0, 0)
  const drawn = p.spots.filter((s) => p.cards.vis[s.id]).length
  check(drawn === 50 && p.cards.budget.refused > 0, 'past its budget of far cards a layer draws no more, and says so', `${drawn} drawn`)
  p.dispose()
  const lc = new LitterCards(16)
  let threw = false
  try { PropArena.over(lc.meshes, 4, 'unbudgeted') } catch { threw = true }
  check(threw, 'a view over the far cards with no budget is refused at construction')
}

if (failed) {
  console.error(`\n${failed} carving check(s) failed`)
  process.exit(1)
}
console.log('all carving checks pass')
