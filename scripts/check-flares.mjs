// Node-side gates for the flare gun (src/v2/flaregun.js) and its flares
// (src/v2/render/flares.js): the wire format, the flight's ends, the sizes, the
// aim's clearance, the layer's dedupe, cap, save and room filter, and the
// window disc's size with the charges.
//
//   node scripts/check-flares.mjs
//
// What can go wrong without throwing: a flare that never reaches its target or
// leaves from somewhere other than the muzzle; two clients flying one flare on
// different paths; a shot into a hillside or under a lake; a peer's flare drawn
// twice; a village's flares hanging over the overworld; a window that stays lit
// with no charge left; a shot's flash that never fades or hides the view in
// white rather than the flare's colour; the pick shipped with its red button still on, or a new
// pick worn with the old one's muzzle and window.

import * as THREE from 'three'
import { Flares, FLARE, MAX_SPARKS, spanOf, walkOf, fromWire, toWire, flightAt, sizeAt, FLIGHT_S, FLY_M, REST_M, MUZZLE_M, GROW_S, CAP, SPIRAL, BOW } from '../src/v2/render/flares.js'
import { FlareGuns, GunWindows, ShotFlash, FLASH_PEAK, FLASH_S, KIND, CHARGES, PALETTE, AIM_M, CLEAR_M, SIZE_M, MUZZLE, WINDOW, WINDOW_N, WINDOW_R, FLAREGUN_GLB, aimTarget, pressSafety, roomKey } from '../src/v2/flaregun.js'
import { readGlbChunks } from '../tools/tripo-pack.mjs'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}
const throws = (fn) => { try { fn(); return false } catch { return true } }
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps

const flare = (over = {}) => ({ id: 'abc123', room: 'overworld', ox: 1, oy: 2, oz: 3, tx: 40, ty: 90, tz: -60, color: PALETTE[1], seed: 0.37, ...over })

console.log('wire')
{
  const f = flare()
  const back = fromWire(toWire(f))
  check(JSON.stringify(back) === JSON.stringify(f), 'a flare survives the wire', JSON.stringify(back))
  check(throws(() => fromWire(toWire(f).slice(0, 9))), 'a short array is refused')
  check(throws(() => fromWire(toWire(flare({ id: 'Has Space' })))), 'a bad id is refused')
  check(throws(() => fromWire(toWire(flare({ room: 'x'.repeat(41) })))), 'a room past 40 characters is refused')
  check(throws(() => fromWire(toWire(flare({ tx: NaN })))), 'a non-finite coordinate is refused')
  check(throws(() => fromWire(toWire(flare({ color: 0x1000000 })))), 'a colour past 24 bits is refused')
}

console.log('flight')
{
  const f = flare()
  const p = new THREE.Vector3()
  flightAt(f, 0, p)
  check(near(p.x, f.ox) && near(p.y, f.oy) && near(p.z, f.oz), 'it leaves from the muzzle', p.toArray().join(', '))
  flightAt(f, 1, p)
  check(near(p.x, f.tx, 1e-4) && near(p.y, f.ty, 1e-4) && near(p.z, f.tz, 1e-4), 'it ends on the target', p.toArray().join(', '))
  const q = new THREE.Vector3()
  flightAt(f, 0.4, p)
  flightAt({ ...f }, 0.4, q)
  check(p.equals(q), 'one seed flies one path on every client')
  flightAt(flare({ seed: 0.81 }), 0.4, q)
  check(p.distanceTo(q) > 0.5, 'another seed flies another path', `${p.distanceTo(q).toFixed(2)} m apart`)
  const straight = new THREE.Vector3(f.ox, f.oy, f.oz).lerp(new THREE.Vector3(f.tx, f.ty, f.tz), 1 - 0.5 * 0.5)
  flightAt(f, 0.5, p)
  check(p.y > straight.y, 'it bows up over the straight line', `${(p.y - straight.y).toFixed(2)} m`)
  const up = flare({ ox: 0, oy: 0, oz: 0, tx: 0, ty: 100, tz: 0 })
  flightAt(up, 0.5, p)
  check(Number.isFinite(p.x) && Number.isFinite(p.z), 'a shot straight up still has a side to spiral on')
  // A steep shot, where a corkscrew turning on the world's up would swing along the line: off the bowed line, only square to it, at the radius.
  const steep = flare({ ox: 0, oy: 0, oz: 0, tx: 20, ty: 90, tz: -10 })
  const d = new THREE.Vector3(steep.tx, steep.ty, steep.tz), len = d.length()
  let along = 0, off = 0
  for (let u = 0.05; u < 1; u += 0.05) {
    const e = 1 - (1 - u) * (1 - u)
    flightAt(steep, u, p)
    const o = p.clone().sub(d.clone().multiplyScalar(e)).setY(p.y - d.y * e - 4 * e * (1 - e) * BOW * len)
    along = Math.max(along, Math.abs(o.dot(d) / len))
    off = Math.max(off, Math.abs(o.length() - SPIRAL * len * Math.sin(Math.PI * u)))
  }
  check(along < 1e-6 && off < 1e-6, 'it corkscrews round its line at an even radius, never along it', `along ${along.toExponential(1)}, radius off ${off.toExponential(1)}`)
}

console.log('size')
{
  check(near(sizeAt(0), MUZZLE_M), `it leaves the muzzle ${MUZZLE_M} m across`)
  check(near(sizeAt(0.5 * FLIGHT_S), FLY_M), `it flies ${FLY_M} m across`)
  check(near(sizeAt(FLIGHT_S), FLY_M), 'it arrives at its flight size')
  check(near(sizeAt(FLIGHT_S + GROW_S), REST_M) && near(sizeAt(Infinity), REST_M), `it rests ${REST_M} m across, a loaded one too`)
  const mid = sizeAt(FLIGHT_S + GROW_S / 2)
  check(mid > FLY_M && mid < REST_M, 'it grows between the two', mid.toFixed(2))
}

console.log('aim')
{
  const out = new THREE.Vector3()
  const muzzle = new THREE.Vector3(0, 1.5, 0)
  const flat = new THREE.Vector3(0, 0, -1)
  aimTarget(muzzle, flat, () => 0, () => null, out)
  check(near(out.z, -AIM_M) && near(out.y, CLEAR_M), `level over flat ground: ${AIM_M} m out, lifted to ${CLEAR_M} m`, out.toArray().join(', '))
  aimTarget(muzzle, flat, () => 50, () => null, out)
  check(near(out.y, 50 + CLEAR_M), 'over a hill it clears the hill', out.y.toFixed(2))
  aimTarget(muzzle, flat, () => -30, () => -5, out)
  check(near(out.y, -5 + CLEAR_M), 'over a lake it clears the water, not its bed', out.y.toFixed(2))
  const high = new THREE.Vector3(0, 1, -1).normalize()
  aimTarget(muzzle, high, () => 0, () => null, out)
  check(near(out.y, 1.5 + AIM_M * Math.SQRT1_2) && near(out.distanceTo(muzzle), AIM_M), 'aimed up it is left where it is aimed', out.y.toFixed(2))
}

console.log('the layer')
{
  const flares = new Flares(new THREE.Scene())
  flares.setRoom('overworld')
  check(flares.add(flare(), 0) === true, 'a new flare is added')
  check(flares.add(flare(), 0.3) === false && flares.list.length === 1, 'the same id again is left be -- a snapshot repeating one she has')
  flares.add(flare({ id: 'glade1', room: roomKey('leafkin', { key: 'hollow:12.0:-4.5' }) }), 0)
  flares.update(0.016, 1000)
  check(flares.mesh.geometry.instanceCount === 1, 'only the current room\'s flares are drawn', `${flares.mesh.geometry.instanceCount}`)
  flares.setRoom('leafkin:hollow:12.0:-4.5')
  flares.update(0.016, 1000)
  check(flares.mesh.geometry.instanceCount === 1 && flares.aPos.array[0] !== 40, 'in the glade, the glade\'s, still in flight')
  flares.setRoom('nowhere')
  flares.update(0.016, 1000)
  check(!flares.mesh.visible, 'a room with none hides the mesh')
  flares.setRoom('overworld')
  flares.update(2, 1000)
  check(flares.aPos.array[0] === 40 && flares.aPos.array[1] === 90 && flares.aSize.array[0] === REST_M, 'arrived, it hangs at its target at rest size')
  flares.add(flare({ id: 'late1' }), 5)
  flares.update(0, 1000)
  check(flares.aSize.array[2] === REST_M, 'a peer\'s flare that arrived before she joined hangs at rest size at once')

  for (let i = 0; i < CAP + 5; i++) flares.add(flare({ id: `n${i}` }), 0)
  check(flares.list.length === CAP && flares.list[0].id === 'n5', `past ${CAP} the oldest are forgotten`, flares.list[0].id)

  const saved = JSON.parse(JSON.stringify(flares.save()))
  const loaded = new Flares(new THREE.Scene())
  loaded.load(saved)
  loaded.setRoom('overworld')
  loaded.update(0.016, 1000)
  check(loaded.list.length === CAP && loaded.aSize.array[0] === REST_M, 'a save loads every flare, long arrived')
  loaded.clear()
  loaded.update(0.016, 1000)
  check(loaded.list.length === 0 && !loaded.mesh.visible, 'clear forgets them all')
  check(throws(() => loaded.load([['bad']])), 'a corrupt save throws')
}

console.log('the rooms')
{
  check(roomKey('overworld', null) === 'overworld', 'the overworld is its own room')
  check(roomKey('Leafkin', { key: 'hollow:3.5:-12.0' }) === 'leafkin:hollow:3.5:-12.0', 'a village is filed by the mouth it is entered from')
  check(fromWire(toWire(flare({ room: roomKey('leafkin', { key: 'hollow:-1234.5:-2345.5' }) }))).room.length <= 40, 'the longest mouth key still passes the wire')
}

console.log('the sparks')
{
  check(spanOf(FLARE) === 2 && walkOf(FLARE) === 5, 'the default look walks its own slice and two either side, 5 sparks a fragment', `span ${spanOf(FLARE)}`)
  let twice = 0, short = 0
  for (let sparks = 1; sparks <= MAX_SPARKS; sparks++) {
    for (const gravity of [0, 0.4, 2, 6]) {
      for (const speed of [0.5, 3.2, 8]) {
        const p = { ...FLARE, sparks, gravity, speed }
        if (walkOf(p) > sparks) twice++
        // Short of every spark, the walk covers the droop's bend and one slice more either side.
        if (walkOf(p) < sparks && (spanOf(p) - 1) * ((2 * Math.PI) / sparks) < Math.atan(gravity / speed)) short++
      }
    }
  }
  check(twice === 0 && short === 0, 'no look walks a slice twice, or too few slices to reach a drooping spark', `${twice} twice, ${short} short`)
  check(throws(() => new Flares(new THREE.Scene()).set({ ...FLARE, sparks: MAX_SPARKS + 1 })) && throws(() => new Flares(new THREE.Scene()).set({ ...FLARE, gain: undefined })), 'a look past MAX_SPARKS, or missing a key, throws')
}

console.log('the gun')
{
  const guns = new FlareGuns()
  const slot = guns.slot()
  check(slot.kind === KIND && slot.charges === CHARGES && slot.hue === null && slot.armed === false && slot.stowable, `a new gun: ${CHARGES} charges, on safe with no colour, stowable`)
  const cycle = { ...slot }
  const steps = []
  for (let k = 0; k < 2 * PALETTE.length + 2; k++) {
    pressSafety(cycle)
    steps.push(cycle.armed ? cycle.hue : 'safe')
  }
  const want = [...PALETTE.keys()].flatMap((h) => [h, 'safe']).concat([0, 'safe'])
  check(steps.join() === want.join(), 'A/X arms it with the first colour, then safe, then the next colour, round the palette', steps.join())
  check(guns.pickAt() === null && throws(() => guns.take()), 'nothing in the world hands one out')
  check(guns.size > 0.2 && guns.size < 0.4, 'it is pistol-sized', guns.size.toFixed(3))
  check(throws(() => guns.dress(slot)), 'it cannot be dressed before it wears its mesh')
  const box = (long) => {
    const g = new THREE.BoxGeometry(0.2, 0.5, long)
    return { pos: g.attributes.position.array, nrm: g.attributes.normal.array, uv: g.attributes.uv.array, idx: Array.from(g.index.array), map: new THREE.Texture() }
  }
  check(throws(() => new FlareGuns().wear(box(0.8))), 'a pick of another length is refused: its muzzle and window were measured on this one')
  guns.wear(box(0.998046875))
  const worn = guns.dress(slot).geometry.boundingBox
  check(near(worn.max.z - worn.min.z, SIZE_M, 1e-6), `worn, it is ${SIZE_M} m long`)
  check(MUZZLE.z < worn.min.z + 0.005 && WINDOW.z > 0 && WINDOW_N.z > 0.9, 'the muzzle is at the front and the window faces back at her', `muzzle z ${MUZZLE.z.toFixed(3)}, window z ${WINDOW.z.toFixed(3)}`)

  // The shipped pick, as tools/props/gen/ship.mjs cut it: pick 0 is 1048 triangles, 68 of them the red button, whose top stood at 0.257.
  const { json } = readGlbChunks(new URL(`../public/${FLAREGUN_GLB}`, import.meta.url).pathname)
  const prim = json.meshes[0].primitives[0]
  const tris = json.accessors[prim.indices].count / 3
  const top = json.accessors[prim.attributes.POSITION].max[1]
  check(tris === 1048 - 68 && top < 0.245, 'the shipped gun has no red button on it', `${tris} tris, top ${top.toFixed(3)}`)

  const over = new THREE.Group()
  const rec = { ...slot }
  pressSafety(rec)
  const frame = new THREE.Matrix4().makeTranslation(5, 1, 2)
  const hands = {
    holding: (key) => (key === 'right' ? rec : null),
    heldFrame: (key, out) => out.copy(frame),
  }
  const windows = new GunWindows(over, ['left', 'right'])
  const disc = (key) => windows.discs.get(key)
  windows.update(hands)
  check(disc('right').visible && !disc('left').visible, 'the window shows on the hand holding the gun only')
  const r = () => new THREE.Vector3().setFromMatrixScale(disc('right').matrix).x
  check(near(r(), WINDOW_R), 'full, the disc fills the window', r().toFixed(4))
  rec.charges = CHARGES / 4
  rec.hue = 4
  windows.update(hands)
  check(near(r(), WINDOW_R / 2) && disc('right').material.color.getHex() === new THREE.Color().setHex(PALETTE[4]).getHex(), 'a quarter left, half the radius, in the chosen colour', r().toFixed(4))
  pressSafety(rec)
  windows.update(hands)
  check(!disc('right').visible, 'on safe, the disc is gone')
  pressSafety(rec)
  rec.charges = 0
  windows.update(hands)
  check(!disc('right').visible, 'empty, the disc is gone')
}

console.log('the flash')
{
  const flash = new ShotFlash(new THREE.Scene())
  const eye = new THREE.Vector3(3, 1.6, -2)
  flash.update(0.016, eye)
  check(!flash.mesh.visible, 'no shot, no flash')
  flash.fire(PALETTE[0])
  flash.update(0, eye)
  const c = flash.mesh.material.color
  check(flash.mesh.visible && near(flash.mesh.material.opacity, FLASH_PEAK) && flash.mesh.position.equals(eye), 'a shot flashes round her head at its peak')
  check(c.r > 0.9 && c.g > 0.5 && c.g < c.r - 0.1 && near(c.g, c.b, 0.05), 'nearly white, tinted the flare\'s red', c.getHexString())
  flash.update(FLASH_S / 2, eye)
  check(near(flash.mesh.material.opacity, FLASH_PEAK / 4), 'halfway, a quarter as bright', flash.mesh.material.opacity.toFixed(3))
  flash.update(FLASH_S / 2 + 1e-3, eye)
  check(!flash.mesh.visible, `gone by ${FLASH_S} s`)
}

if (failures) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall flare checks pass')
