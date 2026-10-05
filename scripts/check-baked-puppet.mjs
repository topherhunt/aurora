// Node-side gates for the baked puppet (src/v2/render/baked-puppet.js).
//
//   node scripts/check-baked-puppet.mjs
//
// What can go wrong without throwing: a texture laid out one way and read another (a body drawn as a crumpled star); a sample that wraps into the next clip; a bone a layer reads that is not where the drawn body has it (a saddle or a grip off the animal); a fade or tint drawn through the wrong batch; a puppet that never leaves the active set.

import * as THREE from 'three'
import { BakedPuppet, bakedBatches, bakedRoot, cullBakedTo, flushBaked, makePuppet, puppetMode, rollTint, setPuppetMode, solverStub, tintFor, tintRange } from '../src/v2/render/baked-puppet.js'
import { Puppet, makePuppetMaterials, makeSettledMaterial, poseSphere } from '../src/v2/render/puppet.js'
import { TIER_TINTS, setTierTint } from '../src/v2/render/critters.js'
import { mulberry32 } from '../src/sim/mathx.js'
import { SHAKE, paddleHz, striderClips } from '../src/v2/render/strider-clips.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}
const throws = (fn) => { try { fn() } catch { return true } return false }

/** Root, a hip, an arm and a three-joint leg; `wave` swings the arm a quarter turn and back over 1 s, `drop` sinks the root over 0.5 s. */
function makeAsset() {
  const root = new THREE.Bone(); root.name = 'Root'
  const hip = new THREE.Bone(); hip.name = 'Hip'; hip.position.set(0, 0.5, 0)
  const arm = new THREE.Bone(); arm.name = 'Arm'; arm.position.set(0, 0.5, 0)
  root.add(hip); hip.add(arm)
  const knee = new THREE.Bone(); knee.name = 'Knee'; knee.position.set(0.1, -0.25, 0)
  const foot = new THREE.Bone(); foot.name = 'Foot'; foot.position.set(0.1, -0.25, 0.1)
  hip.add(knee); knee.add(foot)
  root.updateMatrixWorld(true)
  const bones = [root, hip, arm, knee, foot]
  const skeleton = new THREE.Skeleton(bones, bones.map((b) => b.matrixWorld.clone().invert()))
  const tiers = [3, 1].map((seg) => {
    const g = new THREE.BoxGeometry(0.4, 1.5, 0.4, seg, seg * 3, seg).translate(0, 0.75, 0)
    const pos = g.getAttribute('position'), n = pos.count
    const idx = new Uint16Array(n * 4), wt = new Float32Array(n * 4)
    for (let i = 0; i < n; i++) {
      const y = pos.getY(i), s = Math.min(1, Math.max(0, (y - 0.6) / 0.6))
      idx[i * 4] = 1; idx[i * 4 + 1] = 2; wt[i * 4] = 1 - s; wt[i * 4 + 1] = s
    }
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4))
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wt, 4))
    return g
  })
  const q = (a) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), a).toArray()
  const clips = [
    new THREE.AnimationClip('wave', 1, [new THREE.QuaternionKeyframeTrack('Arm.quaternion', [0, 0.5, 1], [...q(0), ...q(Math.PI / 2), ...q(0)])]),
    new THREE.AnimationClip('drop', 0.5, [new THREE.VectorKeyframeTrack('Root.position', [0, 0.5], [0, 0, 0, 0, -0.5, 0])]),
  ]
  return { root, skeleton, tiers, clips, map: null, legs: [{ id: 'L', chain: ['Hip', 'Knee', 'Foot'] }] }
}

const asset = makeAsset()
const plain = makeSettledMaterial('check-baked')
const mats = () => makePuppetMaterials('check-baked', plain)
const scene = new THREE.Scene()
scene.add(bakedRoot)

console.log('the mode')
{
  check(puppetMode() === 'baked', 'baked is the default')
  check(makePuppet(asset, mats()) instanceof BakedPuppet, 'makePuppet builds a baked body by default')
  setPuppetMode('skinned')
  check(makePuppet(asset, mats()) instanceof Puppet, 'and a skinned one once the mode is skinned')
  setPuppetMode('baked')
  check(throws(() => setPuppetMode('instanced')), 'an unknown mode throws')
  const s = solverStub()
  s.start(); s.steer(1, 2); s.set(1, 1); s.restore(); s.solve(0.1); s.reset()
  check(Object.assign(s.look, { yaw: 1 }).yaw === 1 && s.then === null, 'the solver stub takes every solver call and a look')
}

console.log('the bake')
{
  const p = new BakedPuppet(asset, mats())
  const v = p.vat
  check(v.texture.image.width === 5 * 3 && v.nb === 5, 'three texels a bone', `${v.texture.image.width} wide`)
  check(v.clips.get('wave').n === 30 && v.clips.get('drop').n === 15 && v.rows === 31 + 16, 'each clip is duration x 30 fps rows plus its end row', `${v.rows} rows`)
  check(v.clips.get('drop').start === 31, 'and the clips are stacked in order')
  check(v.texture.type === THREE.FloatType && v.texture.magFilter === THREE.NearestFilter && !v.texture.generateMipmaps, 'float texels, read exact')
  check(new BakedPuppet(asset, mats()).vat === v, 'one bake a skeleton, shared by every puppet over it')
  check(Math.abs(p.feet[0].x - 0.2) < 1e-6 && Math.abs(p.feet[0].z - 0.1) < 1e-6, 'its feet are the legs\' rest feet, as FootIK reads them', JSON.stringify(p.feet[0]))
}

console.log('the clock')
{
  const p = new BakedPuppet(asset, mats(), { oneShot: new Set(['drop']) })
  p.play('wave')
  p.step(1.25)
  check(Math.abs(p.current.time - 0.25) < 1e-9, 'a loop wraps', p.current.time.toFixed(3))
  p.mixer.timeScale = 2
  p.current.timeScale = -1
  p.step(0.2)
  check(Math.abs(p.current.time - 0.85) < 1e-9, 'mixer and action time scales multiply, and a negative one runs it backwards round the loop', p.current.time.toFixed(3))
  p.mixer.timeScale = 1
  p.play('wave', 0)
  check(Math.abs(p.current.time - 0.85) < 1e-9, 'the same clip on the same cue is left playing')
  p.play('wave', 1, 2.3)
  check(Math.abs(p.current.time - 0.3) < 1e-9, 'a new cue restarts it, at `at` modulo its length')
  p.play('drop', 2)
  p.step(2)
  check(p.current.time === 0.5 && p.current.getClip() === asset.clips[1], 'a one-shot holds its end')
  check(throws(() => p.play('fly')), 'an unknown clip throws')
}

console.log('the bones')
{
  const sk = new Puppet(asset, mats())
  const bp = new BakedPuppet(asset, mats())
  sk.show(0, 0); bp.show(0, 0)
  sk.play('wave'); bp.play('wave')
  let worst = 0
  for (const dt of [0.13, 0.21, 0.37, 0.4]) {
    sk.step(dt); bp.step(dt)
    for (let i = 0; i < 5; i++) {
      const a = sk.skeleton.bones[i].matrixWorld.elements, b = bp.skeleton.bones[i].matrixWorld.elements
      for (let k = 0; k < 16; k++) worst = Math.max(worst, Math.abs(a[k] - b[k]))
    }
  }
  check(worst < 5e-3, 'every bone stands where the skinned puppet\'s does at the same time, between samples too', `worst ${worst.toExponential(1)}`)
  check(bp.bones.find((b) => b.name === 'Arm') === bp.skeleton.bones[2] && bp.skeleton.boneInverses === asset.skeleton.boneInverses, 'bones by name and by skeleton index are the same ones, over the shared inverses')
  bp.skeleton.dispose(); bp.release(); sk.release()
}

/** One vertex as the vertex shader skins it: the instance's (row, row, blend) read out of the texture. */
function shaderSkin(p, b, inst, geometry, i) {
  const data = p.vat.texture.image.data, w = p.vat.texture.image.width
  const r0 = b.mesh.geometry.getAttribute('aVat').getX(inst), r1 = b.mesh.geometry.getAttribute('aVat').getY(inst), s = b.mesh.geometry.getAttribute('aVat').getZ(inst)
  const v = new THREE.Vector3().fromBufferAttribute(geometry.getAttribute('position'), i)
  const out = new THREE.Vector3()
  const idx = geometry.getAttribute('skinIndex'), wt = geometry.getAttribute('skinWeight')
  for (let k = 0; k < 4; k++) {
    const weight = wt.getComponent(i, k)
    if (!weight) continue
    const bone = idx.getComponent(i, k)
    const row = (r, c) => { const o = (r * w + bone * 3 + c) * 4; return [0, 1, 2, 3].map((j) => data[o + j]) }
    const m = [0, 1, 2].map((c) => row(r0, c).map((x, j) => x + (row(r1, c)[j] - x) * s))
    out.x += weight * (m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z + m[0][3])
    out.y += weight * (m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z + m[1][3])
    out.z += weight * (m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z + m[2][3])
  }
  return out
}

console.log('the batches')
{
  const a = new BakedPuppet(asset, mats()), b = new BakedPuppet(asset, mats()), sk = new Puppet(asset, mats())
  for (const p of [a, b]) scene.add(p.group)
  a.group.matrix.makeTranslation(5, 0, 0); a.group.matrixWorldNeedsUpdate = true
  for (const p of [a, b, sk]) { p.show(0, 0); p.play('wave') }
  for (const p of [a, b, sk]) p.step(0.31)
  flushBaked()
  let on = bakedBatches()
  check(on.length === 1 && on[0].n === 2 && on[0].mesh.count === 2 && !on[0].fade, 'two settled puppets of one look and tier are one instanced draw', JSON.stringify(on.map((x) => x.n)))
  check(on[0].mesh.parent === bakedRoot && on[0].mesh.instanceColor !== null, 'drawn from bakedRoot, each instance carrying its colour')
  const t = new THREE.Matrix4().fromArray(on[0].mesh.instanceMatrix.array, 0)
  check(t.elements[12] === 5, 'an instance stands where its group\'s world matrix puts it')

  sk.skeleton.update()
  const geo = asset.tiers[0]
  let worst = 0
  for (let i = 0; i < geo.getAttribute('position').count; i++) {
    const want = sk.meshes[0].getVertexPosition(i, new THREE.Vector3())
    worst = Math.max(worst, want.distanceTo(shaderSkin(b, on[0], 1, geo, i)))
  }
  check(worst < 5e-3, 'every vertex the shader skins out of the texture lands where three skins the same pose', `worst ${worst.toExponential(1)} m`)

  b.tint.set(0.5, 1, 1)
  flushBaked()
  check(on[0].mesh.instanceColor.getX(1) === 0.5 && on[0].mesh.instanceColor.getX(0) === 1, 'a puppet\'s tint rides its own instance only')

  b.show(1)
  b.step(0.1)
  flushBaked()
  on = bakedBatches()
  const fading = on.filter((x) => x.fade)
  check(fading.length === 2 && fading.every((x) => x.n === 1), 'a puppet changing tier draws through the fading batch of both tiers', JSON.stringify(on.map((x) => [x.n, x.fade])))
  const sides = fading.map((x) => x.mesh.geometry.getAttribute('aFade').getY(0)).sort()
  check(sides.join() === '-1,1' && fading.every((x) => Math.abs(x.mesh.geometry.getAttribute('aFade').getX(0) - b.fade) < 1e-6), 'one half keeps the pixels the other drops, at the same cut')
  b.step(1)
  flushBaked()
  check(bakedBatches().every((x) => !x.fade), 'once settled it is back on a settled batch')

  setTierTint(true)
  flushBaked()
  on = bakedBatches()
  check(on.length === 2 && on.every((x) => x.mesh.material.isMeshBasicMaterial) && on.find((x) => x.mesh.geometry.index === asset.tiers[1].index).mesh.instanceColor.getX(0) === TIER_TINTS[1].color.r, 'under the tint row each tier draws flat in its rung\'s colour')
  setTierTint(false)

  scene.remove(b.group)
  a.group.visible = false
  flushBaked()
  check(bakedBatches().length === 0 && bakedRoot.children.every((m) => !m.visible || m.count === 0), 'a puppet out of the scene or under a hidden group is not drawn')
  a.group.visible = true
  scene.add(b.group)

  const swap = asset.tiers[1].clone()
  b.meshes[1].geometry = swap
  flushBaked()
  check(bakedBatches().some((x) => x.mesh.geometry.index === swap.index), 'a layer swapping a tier\'s geometry draws through a batch of its own')

  // A wild strider's bare tier: the full one's buffers, drawn short of the tack.
  const bare = new THREE.BufferGeometry()
  for (const [name, attr] of Object.entries(asset.tiers[1].attributes)) bare.setAttribute(name, attr)
  bare.setIndex(asset.tiers[1].index)
  bare.setDrawRange(0, 12)
  b.meshes[1].geometry = bare
  flushBaked()
  const short = bakedBatches().find((x) => x.mesh.geometry.index === bare.index && x.mesh.geometry.drawRange.count === 12)
  check(short !== undefined, 'a tier drawn short (a strider without its saddle) is drawn short in its batch')

  for (let i = 0; i < 40; i++) {
    const p = new BakedPuppet(asset, mats())
    scene.add(p.group); p.show(0, 0)
  }
  flushBaked()
  check(bakedBatches().some((x) => x.n === 41 && x.mesh.count === 41), 'a batch grows past its first capacity')

  b.release()
  a.show(-1)
  check(!a.done, 'a puppet asked to go is not done until it has faded')
  a.step(1)
  check(a.done, 'and is done once it has')

  const vs = THREE.ShaderLib.lambert.vertexShader, fs = THREE.ShaderLib.lambert.fragmentShader
  const settled = bakedBatches().find((x) => !x.fade).mesh.material
  const sh = { vertexShader: vs, fragmentShader: fs, uniforms: {} }
  settled.onBeforeCompile(sh)
  check(sh.uniforms.uVat.value === a.vat.texture && !/skinbase_vertex|skinning_vertex/.test(sh.vertexShader) && !/discard/.test(sh.fragmentShader), 'the settled twin skins from the texture and has no discard')
  check(settled.customProgramCacheKey() === 'check-baked|vat' && settled.color.getHex() === 0xffffff, 'its program is the plain\'s plus |vat, its colour white')
  a.show(1); a.step(0.05)
  flushBaked()
  const fade = bakedBatches().find((x) => x.fade).mesh.material
  const fsh = { vertexShader: vs, fragmentShader: fs, uniforms: {} }
  fade.onBeforeCompile(fsh)
  check(/discard/.test(fsh.fragmentShader) && /aFade/.test(fsh.vertexShader) && fade.customProgramCacheKey() === 'check-baked|vat-fade', 'the fading twin dissolves on its per-instance cut')
  const bsh = { vertexShader: THREE.ShaderLib.basic.vertexShader, fragmentShader: THREE.ShaderLib.basic.fragmentShader, uniforms: {} }
  check(!throws(() => { setTierTint(true); flushBaked(); bakedBatches()[0].mesh.material.onBeforeCompile(bsh); setTierTint(false) }) && /vatBone\( skinIndex\.x \)[\s\S]*transformed = /.test(bsh.vertexShader), 'the unlit tint twin fetches its bones at the skinning')

  const before = bakedRoot.children.length
  const v0 = settled.version
  plain.needsUpdate = true
  flushBaked()
  check(settled.version === v0 + 1, 'a recompile of the plain recompiles its twins')
  plain.dispose()
  flushBaked()
  check(bakedRoot.children.length < before && bakedBatches().length === 0, 'disposing the plain drops its look, its batches and its puppets', `${before} -> ${bakedRoot.children.length}`)
}

console.log('the colours')
{
  const rand = mulberry32(7)
  const rolls = Array.from({ length: 200 }, () => rollTint(rand))
  const means = rolls.map((c) => (c.r + c.g + c.b) / 3)
  check(means.every((m) => m > 0.849 && m < 1.201), 'a roll\'s channel mean stays in [0.85, 1.2]', `${Math.min(...means).toFixed(3)}..${Math.max(...means).toFixed(3)}`)
  const reddest = Math.max(...rolls.map((c) => c.r / c.g)), greenest = Math.max(...rolls.map((c) => c.g / c.r))
  check(reddest > 1.5 && greenest > 1.5, 'rolls reach both a red and a green cast', `r/g ${reddest.toFixed(2)}, g/r ${greenest.toFixed(2)}`)
  check(rollTint(mulberry32(3)).equals(rollTint(mulberry32(3))), 'the same seed rolls the same colour')
  const worn = (key) => { const p = new BakedPuppet(asset, mats()); tintFor(p, key, rollTint); return p.tint }
  check(worn('st:1,2:0').equals(worn('st:1,2:0')) && !worn('st:1,2:0').equals(worn('st:1,2:1')) && !worn(7).equals(new THREE.Color(1, 1, 1)), 'a creature\'s key picks its colour, the same on every take, another key another')
  check(!throws(() => tintFor(new Puppet(asset, mats()), 'st:1,2:0', rollTint)), 'a skinned body, with nowhere to wear one, is left alone')
  check(throws(() => tintFor(new BakedPuppet(asset, mats()), undefined, rollTint)), 'and a body taken with no key throws')
  const path = [[1.05, 1.05, 1.06], [0.62, 0.62, 0.63], [0.78, 0.58, 0.4]], roll = tintRange(path, 0.08)
  const along = Array.from({ length: 500 }, (_, i) => roll(mulberry32(i), new THREE.Color()))
  const inside = along.every((c) => ['r', 'g', 'b'].every((ch, j) => c[ch] >= Math.min(...path.map((p) => p[j])) * 0.92 - 1e-9 && c[ch] <= Math.max(...path.map((p) => p[j])) * 1.08 + 1e-9))
  check(inside && along.every((c) => c.g <= c.r * 1.0001 && c.b <= c.r * 1.03), 'a tintRange rolls only along its path: a white-grey-brown hare is never green or blue')
  check(Math.max(...along.map((c) => c.r)) - Math.min(...along.map((c) => c.r)) > 0.35, 'and over the whole of it, not one spot')
}

console.log('the cull')
{
  // An eye at (0, 1, 10) looking down -Z at the origin; each body is found in the batches by where it stands.
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 1000)
  cam.position.set(0, 1, 10); cam.lookAt(0, 1, 0); cam.updateMatrixWorld(true)
  const at = (x, z) => { const p = new BakedPuppet(asset, mats()); scene.add(p.group); p.group.matrix.makeTranslation(x, 0, z); p.group.matrixWorldNeedsUpdate = true; p.show(0, 0); p.play('wave'); return p }
  const drawnAt = (x, z) => bakedBatches().some((b) => { for (let i = 0; i < b.n; i++) { const e = b.mesh.instanceMatrix.array; if (e[i * 16 + 12] === x && e[i * 16 + 14] === z) return true } return false })
  // The edge body: its pose sphere just clear of the frustum, inside the frame's head-turn margin.
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse))
  const sphere = new THREE.Sphere()
  let edge = 0
  while (frustum.intersectsSphere(sphere.copy(poseSphere(asset.tiers)).applyMatrix4(new THREE.Matrix4().makeTranslation(edge, 0, 0)))) edge += 0.25
  edge += 0.5
  const ahead = at(0.125, 0), behind = at(0.375, 30), side = at(edge, 0), far = at(60, 0)
  cullBakedTo(cam)
  flushBaked()
  check(drawnAt(0.125, 0) && !drawnAt(0.375, 30), 'a body ahead of the eye is drawn and one behind it is not')
  check(drawnAt(edge, 0), 'one just out of view is drawn, against a frame\'s head turn', `${edge.toFixed(2)} m to the side`)
  check(!drawnAt(60, 0), 'one far out to the side is not')
  cullBakedTo(null)
  flushBaked()
  check(drawnAt(0.375, 30) && drawnAt(60, 0), 'with no camera to cull to, every body is drawn')
  for (const p of [ahead, behind, side, far]) { p.release(); p.group.removeFromParent() }
}

console.log('the strider clips')
{
  // A bird: Hips (root) carrying Chest (Neck, a wing either side, each with a tip), Tail and two three-joint legs. `fidget` turns the Chest only; `idle` turns nothing the paddle does, so a leg joint with no track of its own shows any turn left over from the last sample.
  const bone = (name, parent, x, y, z) => { const b = new THREE.Bone(); b.name = name; b.position.set(x, y, z); parent?.add(b); return b }
  const hips = bone('Hips', null, 0, 1, 0), chest = bone('Chest', hips, 0.3, 0.1, 0), neck = bone('Neck', chest, 0.2, 0.3, 0)
  const wl = bone('WingL', chest, 0, 0, -0.2), wr = bone('WingR', chest, 0, 0, 0.2)
  bone('WingLTip', wl, 0, 0, -0.3); bone('WingRTip', wr, 0, 0, 0.3); bone('Tail', hips, -0.4, 0, 0)
  for (const s of ['L', 'R']) { const z = s === 'L' ? -0.15 : 0.15; bone(`Foot${s}`, bone(`Shin${s}`, bone(`Thigh${s}`, hips, 0, -0.1, z), 0, -0.4, 0), 0, -0.4, 0) }
  hips.updateMatrixWorld(true)
  const bones = []; hips.traverse((b) => bones.push(b))
  const skeleton = new THREE.Skeleton(bones, bones.map((b) => b.matrixWorld.clone().invert()))
  const q = (a) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), a).toArray()
  const clips = [
    new THREE.AnimationClip('fidget', 3.2, [new THREE.QuaternionKeyframeTrack('Chest.quaternion', [0, 3.2], [...q(0.2), ...q(0.2)])]),
    new THREE.AnimationClip('idle', 4, [new THREE.QuaternionKeyframeTrack('Neck.quaternion', [0, 2, 4], [...q(0), ...q(0.1), ...q(0)])]),
    new THREE.AnimationClip('walk', 0.9, []),
  ]
  const bird = { root: hips, skeleton, clips, spine: ['Hips', 'Chest'], head: ['Neck'], tail: ['Tail'], legs: ['L', 'R'].map((s) => ({ id: s, chain: [`Thigh${s}`, `Shin${s}`, `Foot${s}`] })) }
  const out = striderClips(bird)
  const named = (n) => out.filter((c) => c.name === n)
  const fidget = named('fidget')[0], paddle = named('paddle')[0]
  check(out.length === 4 && named('fidget').length === 1 && named('walk')[0] === clips[2], 'the clips keep every other clip, one fidget, and add a paddle', out.map((c) => c.name).join(' '))
  check(fidget.duration === 3.2 && paddle.duration === 4, 'the fidget keeps its length and the paddle takes the idle\'s', `${fidget.duration} s, ${paddle.duration} s`)
  const track = (c, n) => c.tracks.find((t) => t.name === `${n}.quaternion`)
  const at = (t, i) => new THREE.Quaternion().fromArray(t.values, i * 4)
  const last = (t) => t.times.length - 1
  const from = new THREE.Quaternion().fromArray(q(0.2))
  const chestT = track(fidget, 'Chest'), peak = chestT.times.findIndex((t) => t >= SHAKE.peak)
  const off = (i) => at(chestT, i).angleTo(from)
  check(off(0) < 1e-4 && off(last(chestT)) < 1e-3, 'the shake is still at the fidget\'s start, where the flutter sounds, and settled by its end', `${off(0).toFixed(5)}, ${off(last(chestT)).toFixed(5)} rad`)
  let most = 0
  for (let i = peak - 15; i <= peak; i++) most = Math.max(most, off(i))
  check(most > 0.15, 'and the chest rolls through its peak', `${most.toFixed(3)} rad`)
  const loops = ['ThighL', 'ShinL', 'FootR'].map((n) => { const t = track(paddle, n); return at(t, 0).angleTo(at(t, last(t))) })
  check(Math.max(...loops) < 1e-3, 'the paddle ends where it starts, so it loops and nothing builds up on a joint with no track of its own', loops.map((a) => a.toFixed(5)).join(' '))
  const thighs = ['L', 'R'].map((s) => at(track(paddle, `Thigh${s}`), 10))
  check(Math.abs(paddleHz(clips[1]) - 1.5) < 1e-9 && thighs[0].angleTo(thighs[1]) > 0.5, 'the paddle strokes 6 times over a 4 s idle, the legs half a stroke apart (a quarter stroke in)', `${paddleHz(clips[1])} Hz, legs ${thighs[0].angleTo(thighs[1]).toFixed(2)} rad apart`)
  check(track(paddle, 'Neck').values.join() === clips[1].tracks[0].values.join(), 'and keeps the idle\'s own track on the bones it leaves alone')
  const p = new BakedPuppet({ ...asset, root: hips, skeleton, clips: out, legs: bird.legs, tiers: asset.tiers.map((g) => g.clone()) }, mats())
  check(!throws(() => { p.play('paddle'); p.play('fidget') }), 'a baked body plays both')
}

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1) }
console.log('\nall ok')
