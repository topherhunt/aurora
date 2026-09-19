// Node-side gate for the summit wreaths (§10, src/v2/render/wreaths.js,
// scripts/make-summits.mjs).
//
//   node scripts/check-wreaths.mjs
//
// What it measures: that public/world/summits.json is what make-summits.mjs
// says it is against the field on disk (each summit is the top of its own
// ground within a metre, the highest peaks are spaced, the ground grid is
// whole); that the card atlas is what make-cloud-cards.mjs says it is; that
// the wreaths are one opaque draw of bounded size in the right slot, each card
// seated in its mountain; and the two things the frame reads off them, the
// local haze gain and the per-frame uniforms.

import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { V2Height, WORLD_SEED } from '../src/v2/height/field.js'
import { RELIEF_SHIPPED } from '../src/v2/height/relief.js'
import { Layers } from '../src/v2/layers/layers.js'
import { Wreaths, CULL_M, HAZE_REACH_M, HAZE_GAIN, LOWER_M, AIR_SHARE, CARDS, WIDTH_M, ASPECT, TILES, GROUND_FADE_M } from '../src/v2/render/wreaths.js'
import { readPng } from '../tools/props/png.mjs'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

const summits = JSON.parse(readFileSync(new URL('../public/world/summits.json', import.meta.url), 'utf8'))
const hm = await Heightmap.read({
  path: new URL('../public/world/height.png', import.meta.url),
  metaPath: new URL('../public/world/height.json', import.meta.url),
})
const field = new V2Height({ heightmap: hm, layers: new Layers(), seed: WORLD_SEED, relief: RELIEF_SHIPPED })

console.log('\n--- wreaths: the summit list --------------------------------')
{
  const S = summits.summits
  check(S.length >= 20 && S.length <= 32, 'twenty to thirty-two summits', `${S.length}`)
  let worstY = 0, worstGrid = 0, notTop = 0, minGap = Infinity
  for (let i = 0; i < S.length; i++) {
    const s = S[i]
    worstY = Math.max(worstY, Math.abs(field.heightAt(s.x, s.z, 0) - s.y))
    // The crest: nothing within 48 m of the centre is more than 2 m higher.
    for (let a = 0; a < 16; a++) for (const r of [16, 32, 48]) {
      if (field.heightAt(s.x + Math.cos((a / 16) * Math.PI * 2) * r, s.z + Math.sin((a / 16) * Math.PI * 2) * r, 0) > s.y + 2) notTop++
    }
    const g = s.ground, n = summits.grid, half = summits.footprint
    if (g.length !== n * n) worstGrid = Infinity
    else {
      const gi = (n - 1) / 2
      worstGrid = Math.max(worstGrid, Math.abs(g[gi * n + gi] - s.y))
      const corner = field.heightAt(s.x - half, s.z - half, 0)
      worstGrid = Math.max(worstGrid, Math.abs(g[0] - corner))
    }
    for (let j = 0; j < i; j++) minGap = Math.min(minGap, Math.hypot(S[j].x - s.x, S[j].z - s.z))
  }
  check(worstY <= 1, 'every summit height is the field on disk', `worst ${worstY.toFixed(2)} m`)
  check(notTop === 0, 'and is the crest of its own ground', `${notTop} higher taps within 48 m`)
  check(worstGrid <= 1, 'the ground grid is the field at its centre and its corner', `worst ${worstGrid.toFixed(2)} m`)
  check(minGap >= summits.spacing, 'no two wreathed summits are closer than the spacing', `${minGap.toFixed(0)} m vs ${summits.spacing}`)
  const sorted = [...S].sort((a, b) => b.y - a.y)
  check(sorted.every((s, i) => s === S[i]), 'listed highest first')
  check(S[0].y > 850 && S[S.length - 1].y >= 420, 'from the highest peak down to the skyline floor', `${S[0].y}..${S[S.length - 1].y} m`)
}

console.log('\n--- wreaths: the card atlas ------------------------------------')
const atlas = readPng(new URL('../public/world/cloud-cards.png', import.meta.url).pathname)
{
  const TILE_W = atlas.width / TILES, TILE_H = atlas.height
  check(TILE_W === 256 && TILE_H === 128 && atlas.channels === 4, `${TILES} RGBA tiles of 256x128, as the renderer expects`, `${atlas.width}x${atlas.height}x${atlas.channels}`)
  check(Math.abs(TILE_H / TILE_W - ASPECT) < 1e-9, 'and a card has the tile\'s aspect')
  const px = (t, x, y) => atlas.data.subarray((y * atlas.width + t * TILE_W + x) * 4, (y * atlas.width + t * TILE_W + x) * 4 + 4)
  let edge = 0, grey = 0, covered = [], darkest = 255, lightest = 0
  for (let t = 0; t < TILES; t++) {
    let c = 0
    for (let y = 0; y < TILE_H; y++) for (let x = 0; x < TILE_W; x++) {
      const p = px(t, x, y)
      if (p[0] !== p[1] || p[1] !== p[2]) grey++
      if ((x === 0 || y === 0 || x === TILE_W - 1 || y === TILE_H - 1) && p[3] > 0) edge++
      if (p[3] > 127) { c++; darkest = Math.min(darkest, p[0]); lightest = Math.max(lightest, p[0]) }
    }
    covered.push(c / (TILE_W * TILE_H))
  }
  check(grey === 0, 'the shading is grey, a multiplier on the lit colour')
  check(edge === 0, 'no tile touches its edge, so a card has no hard rim')
  check(covered.every((c) => c > 0.25 && c < 0.55), 'each tile is a quarter to a half cloud', covered.map((c) => `${(c * 100).toFixed(0)}%`).join(' '))
  check(darkest < 140 && lightest > 230, 'shaded from a dark belly to a lit top', `${darkest}..${lightest}`)
}

console.log('\n--- wreaths: the draw ----------------------------------------')
{
  const scene = new THREE.Scene()
  const cards = new THREE.DataTexture(new Uint8Array(4), 1, 1)
  const w = new Wreaths(scene, summits, cards, { seed: WORLD_SEED })
  const geo = w.mesh.geometry
  const n = summits.summits.length
  check(scene.children.length === 1 && scene.children[0] === w.mesh, 'one mesh, one draw')
  check(w.count >= n * CARDS[0] && w.count <= n * CARDS[1] && geo.index.count === w.count * 6 && !geo.attributes.position, `${CARDS[0]} to ${CARDS[1]} cards a summit, placed by the vertex stage with no position attribute`, `${w.count} cards`)
  check(['aCenter', 'aCorner', 'aSize', 'aGround', 'aTile', 'aSummit'].every((a) => geo.attributes[a]?.count === w.count * 4), 'every vertex carries its card\'s centre, corner, size, ground plane, tile and summit')
  const m = w.material
  check(!m.transparent && m.depthWrite && m.depthTest && m.alphaToCoverage && m.side === THREE.FrontSide, 'opaque, depth-written, alpha-to-coverage, front faces only')
  check(w.mesh.renderOrder > 0 && w.mesh.renderOrder < 950, 'drawn after the terrain and before the dome', `renderOrder ${w.mesh.renderOrder}`)
  check(w.mesh.frustumCulled === false, 'never frustum-culled as one world-spanning sphere')

  const c = geo.attributes.aCenter, sz = geo.attributes.aSize, g = geo.attributes.aGround, sm = geo.attributes.aSummit, tl = geo.attributes.aTile
  let outside = 0, seated = 0, clear = 0, caps = 0, badSize = 0, badTile = 0, steep = 0
  const byTile = new Array(TILES).fill(0)
  for (let i = 0; i < w.count; i++) {
    const v = i * 4
    const cw = sz.getX(v), ch = sz.getY(v)
    if (cw < WIDTH_M[0] || cw > WIDTH_M[1] || Math.abs(ch - cw * ASPECT) > 1e-6) badSize++
    if (Math.abs(c.getX(v) - sm.getX(v)) + cw / 2 > summits.footprint || Math.abs(c.getZ(v) - sm.getY(v)) + cw / 2 > summits.footprint) outside++
    const lift = c.getY(v) - g.getX(v)
    if (lift - ch / 2 < 0) seated++
    if (lift + ch / 2 > GROUND_FADE_M) clear++
    if (c.getX(v) === sm.getX(v) && c.getZ(v) === sm.getY(v)) caps++
    const t = tl.getX(v)
    if (t !== Math.floor(t) || t < 0 || t >= TILES || Math.abs(tl.getY(v)) !== 1) badTile++; else byTile[t]++
    if (Math.abs(g.getY(v)) > 1.5 || Math.abs(g.getZ(v)) > 1.5) steep++
  }
  check(badSize === 0, `every card is ${WIDTH_M[0]} to ${WIDTH_M[1]} m wide and ${ASPECT} as tall`)
  check(outside === 0, 'and inside its summit\'s ground grid')
  check(seated === w.count && clear === w.count, 'every card\'s base is in the rock and its top clear of the fade', `${seated} seated, ${clear} clear`)
  check(caps === n, 'one card on every crest', `${caps} of ${n}`)
  check(badTile === 0 && byTile.every((k) => k > 0), 'every tile of the atlas is used, some flipped', byTile.join(' '))
  check(steep === 0, 'no ground plane steeper than the baked grid can mean', `${steep} over 1.5`)

  const s0 = summits.summits[0]
  const far = { x: s0.x + 5000, y: 0, z: s0.z }
  check(w.hazeGain(far) === 1, 'the haze gain is 1 clear of every wreath')
  check(Math.abs(w.hazeGain({ x: s0.x, y: 0, z: s0.z }) - HAZE_GAIN) < 1e-9, `and HAZE_GAIN (${HAZE_GAIN}) at a summit`)
  // The shape of one wreath's gain, on a world with only that wreath, since a
  // walk out of the real one runs into its neighbour's reach.
  const lone = new Wreaths(new THREE.Scene(), { ...summits, summits: [s0] }, cards, { seed: WORLD_SEED })
  let mono = true, prev = HAZE_GAIN
  for (let d = 0; d <= HAZE_REACH_M + 200; d += 10) {
    const gain = lone.hazeGain({ x: s0.x + d, y: 0, z: s0.z })
    if (gain > prev + 1e-9) mono = false
    prev = gain
  }
  check(mono && lone.hazeGain({ x: s0.x + HAZE_REACH_M, y: 0, z: s0.z }) === 1, 'falling to 1 by the reach, never rising on the way out')
  check(lone.hazeGain({ x: s0.x + CULL_M, y: 0, z: s0.z }) === HAZE_GAIN, 'and full inside the cull radius, where the cap card itself is gone')
  lone.dispose()

  const state = { cover: 1, fog: [0.5, 0.6, 0.7] }
  w.update({ x: 5, y: 0, z: 7 }, state)
  check(w.uniforms.uLower.value === LOWER_M && w.uniforms.uHead.value.x === 5 && w.uniforms.uHead.value.y === 7, 'update lowers the base by LOWER_M at full cover and hands the head across')
  const air = w.uniforms.uAir.value
  check(air.x === 0.5 && air.y === 0.6 && air.z === 0.7, 'and the horizon colour the cards fade to, as raw sRGB')
  check(AIR_SHARE > 0 && AIR_SHARE < 1, `a card fades to it at a share of the ridge's rate (${AIR_SHARE})`)
  const lowered = w.uniforms.uThick.value
  w.update({ x: 5, y: 0, z: 7 }, { cover: 0, fog: state.fog })
  check(w.uniforms.uThick.value > lowered && w.uniforms.uLower.value === 0, 'clear weather lifts the base back and erodes the cards to their cores')
  w.visible = false
  check(w.mesh.visible === false, 'the row hides the mesh')
  w.dispose()
  check(scene.children.length === 0, 'dispose takes it out of the scene')
}

console.log(failures === 0 ? '\nwreaths: all checks passed' : `\nwreaths: ${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
