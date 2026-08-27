import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { buildTextureArray, loadImageLayers, LAYER, TEX_SIZE, TILE_METRES } from './textures.js'
import { createPropMaterial } from './material.js'
import { planBuilding, KINDS, WALL_STYLES, ROOF_KINDS } from './buildings/plan.js'
import { buildBuilding2 } from './buildings/v2/building.js'
import { makeCharacter, makeWarp } from './buildings/v2/warp.js'
import { openEdges, signedVolume } from './buildings/v2/parts.js'
import {
  BUILDING_BANDS, CARD_COMBOS, RIDGE_PX, buildingCardFrames, bakeBuildingCardBank, cardLayerFor,
  buildBuildingCross,
} from './buildings/v2/card.js'
import { grassTexture } from './preview-stage.js'
import { TRI_BUDGET, CALL_BUDGET } from './budget.js'

// ---------------------------------------------------------------------------
// The procedural building previewer (gen-building.html).
//
// v1's bench answered "does the grammar cover a range" and it answered it well
// enough that the plan layer is shared unchanged. What it could not answer is
// the thing v2 exists for: HOW CROOKED IS TOO CROOKED. That is not a question
// with a computable answer -- a warp large enough to read as hand-built and
// small enough to still read as a building is a matter of looking -- so this
// page is built around making the amount adjustable and the comparison direct.
//
// Three things it has that v1's does not:
//
//   A MASTER STRENGTH, at the top, in a different colour. Every term of the
//   personality scales from it, and at 0 the page builds exactly the straight
//   thing v1 builds. That control case is the whole point: "is this better"
//   needs a "than what", and the answer is one slider away rather than a
//   different URL.
//
//   PER-TERM MULTIPLIERS underneath it. When a building looks wrong the useful
//   question is WHICH term did it -- a roof that sags too far and an eave that
//   reaches too far are both "too warped" from across the room and are fixed by
//   different numbers. These drive buildBuilding2's `character` override, which
//   exists for this page and which the game never uses.
//
//   A SIDE-BY-SIDE. `vs straight` puts the strength-0 twin of the same seed
//   beside the warped one. Judging a warp against a memory of the straight
//   version is judging it against nothing.
//
// Like v1's, it runs THE REAL MATERIAL -- the actual shared DataArrayTexture
// and createPropMaterial() -- because the premise of the kit is one draw call
// for thatch, logs, stone and glass together, and a previewer that faked that
// would be checking the one thing not in question.
// ---------------------------------------------------------------------------

// --- what the panel can drive -----------------------------------------------

// The personality. `strength` is the master; the rest multiply one group of
// terms each, so a term can be isolated without editing warp.js.
const CHARACTER = [
  ['strength', 0, 1.6, 0.02, 'scales the whole personality. 0 builds the straight v1 building; 1 is what ships. Past 1 is for finding where it breaks, not for using'],
  ['noise', 0, 2, 0.05, 'the two octaves of the field itself -- the coarse one bows a whole wall, the fine one takes the machine edge off a member'],
  ['lean', 0, 2, 0.05, 'the settle. Grows as height^1.35, so the eaves lean and the plinth does not'],
  ['batter', 0, 2, 0.05, 'how far off plumb the walls were RAISED, as opposed to how far they have since settled. Mirrored about the building\'s own centre line, so the two walls of a pair splay apart or pinch together instead of both tipping the same way'],
  ['roofSag', 0, 2, 0.05, 'how far the covering bows between ridge and eave, and how much the two buckle seams wander along their length'],
  ['ridge', 0, 2, 0.05, 'the ridge line\'s OWN droop, signed per building -- it dips in the middle on some and humps up on others'],
  ['eave', 0, 2, 0.05, 'how far the eave line swells past its nominal overhang, and how much it rises and falls along it. The sinuous bottom roofline lives here, and only about two buildings in three get any of it'],
  ['oversail', 0, 2, 0.05, 'how much the roof projects past its walls, as a per-building multiplier on the plan, plus how differently it projects at the ridge end of a gable and at the eave end'],
  ['rake', 0, 2, 0.05, 'the lean of the thatch skirt hanging off the eave: outward away from the wall, or tucked back under the roof'],
  ['flare', 0, 2, 0.05, 'how much wider the chimney crown is than its base'],
  ['openings', 0, 2, 0.05, 'how far a window flares from sill to head, how far it is rotated, and how far a shutter stands off the wall. All of it symmetric -- no corner moves without its partner'],
  ['bow', 0, 2, 0.05, 'how far a post or a rail bows off the straight line between its ends'],
  ['smooth', 0, 180, 5, 'the crease angle for shading. Facets meeting at less than this share one averaged normal, so a five-sided log reads round; above it they each keep their own and the edge stays hard. 0 is all hard, 180 is all smooth, 78 ships'],
]

// Scales rather than absolutes, so a slider means the same thing across a hut
// and an inn and the kind tables stay the source of truth for proportion.
const SLIDERS = [
  ['areaScale', 0.5, 2.0, 0.01, 'multiplies the footprint area drawn for this kind'],
  ['ratioScale', 0.5, 1.8, 0.01, 'multiplies the long:short ratio. High = a range, low = a square block'],
  ['wallScale', 0.6, 1.6, 0.01, 'multiplies eave height. Low = a squat croft, high = a hall'],
  ['pitchScale', 0.5, 1.6, 0.01, 'multiplies roof pitch. Thatch needs a steep pitch to shed water -- under ~45 deg it stops reading as thatch'],
  ['overhang', 0, 0.9, 0.01, 'metres the roof projects past the wall BEFORE the eave reaches. This is the shadow line under the eave, and it is most of what makes a roof look built'],
  ['windowScale', 0, 2, 0.05, 'multiplies how many bays get glazed'],
  ['slope', 0, 0.35, 0.005, 'ground fall per metre across the site. Drives the plinth, the steps and the porch -- none of those are style knobs'],
]

const DEFAULTS = {
  areaScale: 1, ratioScale: 1, wallScale: 1, pitchScale: 1,
  overhang: 0.4, windowScale: 1, slope: 0,
}
const CHAR_DEFAULTS = {
  strength: 1, noise: 1, lean: 1, batter: 1, roofSag: 1, ridge: 1, eave: 1, oversail: 1,
  rake: 1, flare: 1, openings: 1, bow: 1, smooth: 78,
}

const params = { ...DEFAULTS, seed: 1 }
const chars = { ...CHAR_DEFAULTS }
const picks = { kind: 'cottage', shape: 'auto', style: 'auto', roof: 'auto', detail: 2 }

/**
 * The personality this seed and this panel ask for.
 *
 * `flare` and `overhang` multiply the EXCESS over 1, not the value. A flare of 1
 * is a chimney whose crown matches its base and an overhang of 1 is exactly what
 * the plan asked for, so scaling the whole number would make the "off" position
 * invert the taper and delete the eaves rather than removing the variation.
 */
function characterFor(seed) {
  const k = makeCharacter(seed, chars.strength)
  k.amp *= chars.noise
  k.amp2 *= chars.noise
  k.leanX *= chars.lean
  k.leanZ *= chars.lean
  k.batterX *= chars.batter
  k.batterZ *= chars.batter
  k.sag *= chars.roofSag
  k.buckle *= chars.roofSag
  k.ridgeSag *= chars.ridge
  k.reach *= chars.eave
  k.sway *= chars.eave
  k.overhang = 1 + (k.overhang - 1) * chars.oversail
  k.vergeSplay *= chars.oversail
  k.rake *= chars.rake
  k.flare = 1 + (k.flare - 1) * chars.flare
  k.skew *= chars.openings
  k.tilt *= chars.openings
  k.splay *= chars.openings
  k.bow *= chars.bow
  return k
}

// --- scene ------------------------------------------------------------------

const stage = document.getElementById('stage')
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace
stage.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0a1018)

const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 400)
camera.position.set(9, 5.5, 12)

const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, 2, 0)
controls.enableDamping = true
controls.autoRotate = false
controls.autoRotateSpeed = (0.3 * 60) / (2 * Math.PI)

// The game's noon, same rig as v1's bench, so a wall is judged under the light
// it will stand in. One directional light is also all the Quest gets
// (DESIGN.md §8), so this is not a simplification -- it is the actual budget.
// It matters more here than it did in v1: the warp's whole payoff is that a
// bowed surface catches the sun unevenly, and that is invisible under flat or
// generous lighting.
const sun = new THREE.DirectionalLight(0xfff3e2, 2.1)
sun.position.set(3, 5, 2)
scene.add(sun)
scene.add(new THREE.HemisphereLight(0x9fc6ff, 0x2a2418, 0.85))

scene.fog = new THREE.Fog(0x0a1018, 55, 130)

// --- ground -----------------------------------------------------------------
//
// A real mesh rather than a flat plane, because `slope` has to be VISIBLE: the
// plinth, the steps and the porch are all generated from the fall across the
// site, and a building sitting on level ground while the plan believes it is on
// a hillside would make all three look like bugs.

const GROUND_SIZE = 160
const GROUND_SEG = 40
const groundTex = grassTexture(renderer)
groundTex.repeat.set(GROUND_SIZE / 3, GROUND_SIZE / 3)
const groundGeo = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE, GROUND_SEG, GROUND_SEG)
groundGeo.rotateX(-Math.PI / 2)
const ground = new THREE.Mesh(groundGeo, new THREE.MeshLambertMaterial({ map: groundTex }))
scene.add(ground)

/** A single hillside falling toward +X. One slope, not noise: the question the
 *  slider asks is "how much fall", and noise would make the answer unrepeatable
 *  from seed to seed for no gain. */
const groundAt = (x) => -x * params.slope

function reshapeGround() {
  const pos = groundGeo.getAttribute('position')
  for (let i = 0; i < pos.count; i++) pos.setY(i, groundAt(pos.getX(i)))
  pos.needsUpdate = true
  groundGeo.computeVertexNormals()
}

const grid = new THREE.GridHelper(20, 20, 0x2b4a72, 0x16233a)
scene.add(grid)

// A 1.75 m figure by the door. Every proportion decision on this page -- how big
// a log is, how tall an eave is, whether a window reads as a window -- is
// really a question about a person standing next to it, and nothing else in
// shot answers it.
const figure = new THREE.Group()
{
  const mat = new THREE.MeshBasicMaterial({ color: 0x4a7fbf, fog: false })
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 1.0, 4, 8), mat)
  body.position.y = 0.88
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), mat)
  head.position.y = 1.62
  figure.add(body, head)
}
scene.add(figure)

// --- the real material ------------------------------------------------------

const textureArray = buildTextureArray()
// NO billboardLayers, and that is deliberate rather than an omission. Buildings
// have no spun tier -- the cross runs the whole way to the cull distance -- and
// naming the card layer here would arm material.js's spin test against it. See
// the contract note in card.js.
const material = createPropMaterial(textureArray, { vertexColors: true })
material.side = THREE.FrontSide // buildings are closed solids; foliage is not

// A CARD NEEDS THE OTHER SIDE. The building material is FrontSide because the
// kit is a union of closed solids and backface culling is free triangles; a
// card is one quad with a picture on it and culling its back half is the two
// planes of the cross vanishing as you walk round them. Same shader, same
// array, one flag apart -- so it is a second material rather than a second
// material SYSTEM, and in the game both tiers would draw from the same batch.
const cardMaterial = createPropMaterial(textureArray, { vertexColors: true })
cardMaterial.side = THREE.DoubleSide
// The tree/fern layers arrive from PNGs a few frames later. Buildings do not
// use any of them, but the array is shared and patching it late is how the
// runtime behaves, so the previewer does it too.
loadImageLayers(textureArray).catch(() => {})

const group = new THREE.Group()
scene.add(group)

// --- build ------------------------------------------------------------------

const GALLERY_COLS = 4
const GALLERY_ROWS = 3
const GALLERY_N = GALLERY_COLS * GALLERY_ROWS

let galleryMode = false
let ghostMode = false
let wireframe = false
let showGrid = true

const auto = (v) => (v === 'auto' ? null : v)

function planFor(seed) {
  return planBuilding({
    seed,
    kind: picks.kind,
    shape: auto(picks.shape),
    style: auto(picks.style),
    roof: auto(picks.roof),
    groundAt: params.slope > 0 ? groundAt : null,
    tweak: params,
  })
}

function clearGroup() {
  for (const child of group.children) child.geometry.dispose()
  group.clear()
}

/** The two card tiers are named rather than numbered, because they are not
 *  further steps down the same ladder -- they are a photograph of the bottom
 *  step. `cardTier()` is null while a mesh tier is selected. */
function cardTier() {
  return typeof picks.detail === 'string' ? picks.detail : null
}

/** The twenty photographs, one per wall style x roof kind, rebaked whenever the
 *  character sliders move so that what the card wears matches the mesh beside
 *  it. In the game this runs ONCE at load and never again -- the bank is keyed
 *  on material, not on building, so nothing a village does can invalidate it.
 *  Here the sliders are the whole point, so the previewer pays for the rebake.
 *
 *  Cached on the slider state rather than rebuilt per frame: twenty detail-0
 *  cottages and twenty render targets is cheap once and wasteful on every
 *  orbit. */
let cardBank = null
let cardBankKey = ''
function bank() {
  const key = JSON.stringify(chars)
  if (cardBankKey !== key) {
    cardBank = bakeBuildingCardBank(renderer, textureArray, {
      characterFor, smoothAngle: chars.smooth,
    })
    cardBankKey = key
  }
  return cardBank
}

/** One building's card: its own two true widths, wearing the shared photograph
 *  its material pair maps to.
 *
 *  The frames come from THIS building and the picture comes from the bank, and
 *  that split is the design: the silhouette is exact for every variant while
 *  twenty slices cover all 148 of them. `entry` is the stand-in that was
 *  actually photographed, so the panel can name it. */
function buildCard(plan) {
  const built = buildBuilding2(plan, {
    detail: 0, character: characterFor(plan.seed), smoothAngle: chars.smooth,
  })
  const frames = buildingCardFrames(built.geometry)
  built.geometry.dispose()
  const layer = cardLayerFor(plan)
  const entry = bank()[layer - bank()[0].layer]
  const geometry = buildBuildingCross(frames, layer)
  return { geometry, frames, entry, triangles: geometry.userData.impostor.triangles }
}

function rebuild() {
  clearGroup()
  material.wireframe = wireframe
  cardMaterial.wireframe = wireframe

  const tier = cardTier()
  // A GALLERY OF CARDS IS NOW HONEST. It used not to be: the photograph lived in
  // one shared layer that the next bake overwrote, so twelve cards were twelve
  // copies of whichever building was shot last. The bank is keyed on material
  // instead of on building, so twelve cards are twelve seeds' own widths wearing
  // whichever of the twenty pictures their style and roof map to -- and where
  // two of them share a picture, that is the scheme working, not a bug.
  const seeds = galleryMode
    ? Array.from({ length: GALLERY_N }, (_, i) => Number(params.seed) + i)
    : [Number(params.seed)]

  // Gallery spacing keys off the widest building actually built, not off a
  // constant: `areaScale` at 2.0 makes an inn 16 m across and a fixed grid
  // would drive them into each other.
  const plans = seeds.map(planFor)
  const spacing = Math.max(...plans.map((p) => Math.max(p.stats.width, p.stats.depth))) + 5

  let tris = 0
  let dormers = 0
  let card = null
  let probeGeo = null
  const hero = plans[0]

  if (tier && galleryMode) {
    plans.forEach((plan, i) => {
      const one = buildCard(plan)
      tris += one.triangles
      if (i === 0) card = one
      const mesh = new THREE.Mesh(one.geometry, cardMaterial)
      mesh.position.set(
        ((i % GALLERY_COLS) - (GALLERY_COLS - 1) / 2) * spacing,
        0,
        (Math.floor(i / GALLERY_COLS) - (GALLERY_ROWS - 1) / 2) * spacing
      )
      group.add(mesh)
    })
  } else if (tier) {
    // THE CARD IS SHOWN BESIDE THE MESH IT IS A PHOTOGRAPH OF, not instead of
    // it. A card on its own is unjudgeable -- it is a picture of a building and
    // it looks like one, and the only question worth asking of it is where it
    // stops matching, which needs the thing it stopped matching from in the
    // same shot. The detail-0 tier stands on -X, where `vs straight` puts its
    // twin, for the same reason: uphill, on the ground the plan was written for.
    card = buildCard(hero)
    tris = card.triangles
    group.add(new THREE.Mesh(card.geometry, cardMaterial))
    const mesh0 = buildBuilding2(hero, {
      detail: 0, character: characterFor(hero.seed), smoothAngle: chars.smooth,
    })
    dormers = mesh0.dormers.length
    probeGeo = mesh0.geometry
    const twin = new THREE.Mesh(mesh0.geometry, material)
    twin.position.set(-(hero.stats.width + 3), 0, 0)
    group.add(twin)
  } else {
    plans.forEach((plan, i) => {
      const built = buildBuilding2(plan, {
        detail: picks.detail, character: characterFor(plan.seed), smoothAngle: chars.smooth,
      })
      const { geometry, triangles } = built
      tris += triangles
      if (i === 0) {
        dormers = built.dormers.length
        probeGeo = geometry
      }
      const mesh = new THREE.Mesh(geometry, material)
      if (galleryMode) {
        mesh.position.set(
          ((i % GALLERY_COLS) - (GALLERY_COLS - 1) / 2) * spacing,
          0,
          (Math.floor(i / GALLERY_COLS) - (GALLERY_ROWS - 1) / 2) * spacing
        )
      }
      group.add(mesh)
    })

    // The control case, stood next to the thing rather than remembered. Placed
    // on -X, which is UPHILL when `slope` is on, so the twin sits on the same
    // ground the plan was written against rather than floating over the fall.
    if (ghostMode && !galleryMode) {
      const twin = buildBuilding2(hero, { detail: picks.detail, strength: 0 })
      const mesh = new THREE.Mesh(twin.geometry, material)
      mesh.position.set(-(hero.stats.width + 3), 0, 0)
      group.add(mesh)
    }
  }

  // The figure stands where the plan put the door, one pace out from it, so it
  // is measuring the thing it is next to.
  figure.visible = !galleryMode && showGrid
  const doorZ = hero.door.z + (hero.porch ? hero.porch.depth : 0) + 0.9
  figure.position.set(hero.door.x + 0.95, groundAt(hero.door.x + 0.95), doorZ)

  grid.visible = showGrid && !galleryMode
  grid.position.y = 0.01

  return { tris, plans, hero, spacing, dormers, card, probeGeo }
}

// --- panels -----------------------------------------------------------------

function table(el, rows) {
  el.innerHTML = rows
    .map(([k, v, cls]) => `<tr><td class="k">${k}</td><td class="n ${cls ?? ''}">${v}</td></tr>`)
    .join('')
}

// §5's `structure` prop class mesh tier, re-priced for v2 and kept in step with
// scripts/check-buildings-v2.mjs, which is the one that actually fails the
// build. v2 spends triangles on the roof grid and buys most of them back on the
// chimney and the window surrounds; 2700 is where that nets out with margin,
// the last 100 of it bought for the dormer, which is a new part rather than an
// old one that swelled and is capped at two a building.
const STRUCTURE_BUDGET = 2700
// The detail-1 cap, absolute rather than a ratio -- see the gate for why.
const LOD1_BUDGET = 460
// §5's budget table allots 20 visible buildings to a village.
const VISIBLE_BUILDINGS = 20

function refresh() {
  const s = rebuild()
  const plan = s.hero
  const per = Math.round(s.tris / s.plans.length)

  // The airtightness probe, run on the geometry that is ON SCREEN rather than
  // on a rebuild, so this panel cannot disagree with what you are looking at.
  // It matters more in v2 than it did in v1, because the warp is exactly the
  // kind of change that would open a seam if the field were not keyed on
  // position -- this readout is the claim in warp.js being checked live, on the
  // building you are currently looking at, at whatever strength you have set.
  // On a card tier the thing at the front of the group is the card, and a card
  // is a SHEET -- open by construction, zero volume, and asking it about
  // airtightness would report eight open edges and a failure that is not one.
  // So the probe follows the building rather than the front of the group.
  const heroGeo = s.probeGeo
  // A card gallery contains only sheets, so there is no on-screen closed
  // building to probe. Keep the card gallery's budget panel useful without
  // pretending that its photographs are airtight solids.
  const open = heroGeo ? openEdges(heroGeo).length : null
  const vol = heroGeo ? signedVolume(heroGeo) : null

  table(document.getElementById('geo'), [
    ['triangles', `<span class="big">${s.tris.toLocaleString()}</span>${s.plans.length > 1 ? ` (${per} ea)` : ''}`],
    ['draw calls', '1', 'ok'],
    ['texture layers used', heroGeo ? usedLayers(heroGeo).length : '--'],
    ['structure budget', `${per} / ${STRUCTURE_BUDGET}`, per <= STRUCTURE_BUDGET ? 'ok' : 'warn'],
    ['airtight', heroGeo ? (open === 0 ? 'yes' : `${open} open edges`) : '--', heroGeo ? (open === 0 ? 'ok' : 'warn') : ''],
    ['enclosed volume', heroGeo ? `${vol.toFixed(1)} m&sup3;` : '--', heroGeo ? (vol > 0 ? 'ok' : 'warn') : ''],
  ])
  document.getElementById('geonote').innerHTML =
    `One mesh, one material, one call -- walls, thatch, stone and glass together, warped and ` +
    `still closed. That is what the per-vertex <code>texLayer</code> buys, and it is the reason a ` +
    `village can be ~450 static pieces merged into a single draw (&sect;6).`

  // What the field is actually doing to THIS building, in metres, measured by
  // APPLYING it rather than quoted from the sliders -- a number read off the
  // parameters would still be right if the warp had silently stopped being
  // applied. Measured against the straight build's own vertices rather than by
  // differencing the two builds, because they no longer have the same vertices:
  // a log wall stops its courses under the roof it actually stands under, so a
  // sagged eave carries one course fewer than a straight one.
  const k = characterFor(plan.seed)
  const straight = buildBuilding2(plan, { detail: picks.detail, strength: 0 })
  const moved = maxDisplacement(straight.geometry, makeWarp(k, plan.plinthBottom, plan.footprint))
  straight.geometry.dispose()

  // The batter is signed and both signs mean something, so it is printed with
  // its sign rather than with a word: a minus here is a wall leaning IN over
  // the floor, which is the rarer and the more striking of the two.
  const sgn = (v) => `${v >= 0 ? '+' : '&minus;'}${(Math.abs(v) * 100).toFixed(1)}`
  table(document.getElementById('charTable'), [
    ['strength', k.strength.toFixed(2), k.strength > 0 ? 'hot' : ''],
    ['worst vertex moved', `${moved === null ? '--' : `${moved.toFixed(3)} m`}`, 'hot'],
    ['lean at the eave', `${(Math.hypot(k.leanX, k.leanZ) * Math.pow(Math.max(0, plan.stats.ridgeY - plan.plinthBottom), k.leanPow)).toFixed(3)} m`],
    ['wall batter', `${sgn(k.batterX)} / ${sgn(k.batterZ)} cm per m of height, across x / z. Plus splays out, minus leans in`],
    ['roof sag', `${k.sag.toFixed(3)} m`],
    ['buckle seams', `${k.buckle.toFixed(3)} m`],
    ['ridge droop', `${k.ridgeSag >= 0 ? '' : '&minus;'}${Math.abs(k.ridgeSag).toFixed(3)} m ${k.ridgeSag >= 0 ? 'dip' : 'hog'}`],
    ['eave reach', `${k.reach.toFixed(3)} m`],
    ['eave sway', `${k.sway.toFixed(3)} m`, k.sway > 0.05 ? 'hot' : ''],
    ['oversail', `&times; ${k.overhang.toFixed(2)}`],
    // A FRACTION OF THE SLOPE RUN, not a distance, which is why it reads as a
    // percentage here: the term fixes the ANGLE the rake makes with the gable
    // wall, so the same number puts the same amount of character on a hut and on
    // an inn. planGableRoof turns it into metres by multiplying by that mass's
    // run, and the sign says which end of the rake gets thrown out -- it is
    // anchored on the other end rather than centred, so the nominal verge is
    // always the floor.
    ['verge splay', `${k.vergeSplay >= 0 ? '' : '&minus;'}${(Math.abs(k.vergeSplay) * 100).toFixed(1)} % of the run, ${k.vergeSplay >= 0 ? 'at the ridge' : 'at the eave'}`],
    ['eave rake', `${k.rake >= 0 ? '' : '&minus;'}${Math.abs(k.rake).toFixed(2)} ${k.rake >= 0 ? 'out' : 'under'}`],
    ['chimney flare', `&times; ${k.flare.toFixed(2)}`],
    ['window flare', `${(k.skew * 160).toFixed(1)} % sill to head`],
    ['window tilt', `${((k.tilt * 180) / Math.PI).toFixed(1)}&deg;`],
    ['shutter splay', `${k.splay.toFixed(3)} m`],
    ['post bow', `${k.bow.toFixed(3)} m`],
    ['crease angle', `${chars.smooth.toFixed(0)}&deg;`],
  ])

  table(document.getElementById('planTable'), [
    ['kind', plan.kind],
    ['shape', plan.shape],
    ['wall style', plan.style],
    ['roof', plan.roofKind],
    ['rooms', plan.stats.rooms],
    ['floor area', `${plan.stats.area} m&sup2;`],
    ['footprint', `${plan.stats.width.toFixed(1)} &times; ${plan.stats.depth.toFixed(1)} m`],
    ['ridge height', `${plan.stats.ridgeY.toFixed(2)} m`],
    ['windows', plan.stats.windows],
    // Not a plan number like the rest of this table: a dormer is decided while
    // the roof is being drawn, by asking the covering whether it can close over
    // the back of one, so the only place the answer exists is the finished
    // building. It reads here anyway because this is the panel you look at when
    // you are wondering what you are looking at.
    ['dormers', s.dormers],
    ['ground fall', `${(plan.groundMax - plan.groundMin).toFixed(2)} m`],
    ['plinth', `${(plan.floorY - plan.plinthBottom).toFixed(2)} m`],
    ['porch / steps', `${plan.porch ? 'porch' : '--'} / ${plan.steps ? `${Math.round((plan.floorY - plan.steps.groundY) / 0.19)} steps` : '--'}`],
  ])

  // The three mesh tiers, always all three, always from the same plan and the
  // same character -- so the ratio on screen is the ratio the gate measures.
  //
  // EVERY ROW CARRIES ITS BAND, near edge to far edge, because a triangle count
  // on its own says nothing about whether it is the right count: 67 triangles
  // is generous at 300 m and threadbare at 30. The two card rows carry their
  // apparent SIZE as well -- a 6 m ridge at §5's 16.2 px per degree of Quest 2
  // eye -- since that is the number that decides whether a picture is enough.
  const B = BUILDING_BANDS
  const px = (d) => `${(RIDGE_PX / d).toFixed(0)} px`
  const tiers = [2, 1, 0].map((d) => buildBuilding2(plan, { detail: d, character: k }))
  table(document.getElementById('lod'), [
    ['detail 2 &mdash; 0 to ' + B.detail2 + ' m', `${tiers[0].triangles} tris`],
    [`detail 1 &mdash; ${B.detail2} to ${B.detail1} m`, `${tiers[1].triangles} / ${LOD1_BUDGET} tris`, tiers[1].triangles <= LOD1_BUDGET ? 'ok' : 'warn'],
    [`detail 0 &mdash; ${B.detail1} to ${B.detail0} m`, `${tiers[2].triangles} tris`, 'ok'],
    ['ratio', `1 : ${(tiers[0].triangles / Math.max(1, tiers[1].triangles)).toFixed(1)} : ${(tiers[0].triangles / Math.max(1, tiers[2].triangles)).toFixed(1)}`],
    [`cross &mdash; ${B.detail0} to ${B.cull} m`, `4 tris, ${px(B.detail0)} to ${px(B.cull)}`, 'ok'],
  ])
  const d2 = tiers[0].triangles
  for (const t of tiers) t.geometry.dispose()

  // What the photograph came out like, and it is here rather than in a console
  // because the failure this catches is silent: a card framed wrong is a card
  // that is EMPTY, and an empty card draws nothing at all rather than drawing
  // something wrong. Coverage is the fraction of the slice the building
  // actually covers -- a few points either side of a third is a building that
  // filled its frame; near zero means the camera missed.
  const cardEl = document.getElementById('card')
  if (s.card) {
    const { frames, entry } = s.card
    const bankKB = CARD_COMBOS.length * 64
    table(cardEl, [
      // The two halves of the scheme, in the order they matter. First: WHICH
      // PICTURE, which is a property of the material pair and not of this
      // building -- the stand-in named here is the cottage that was actually
      // photographed, and it is a different building from the one on screen.
      ['wears combo', `${entry.style} / ${entry.roof}`],
      ['photographed', `cottage seed ${entry.plan.seed}, ${entry.frames[entry.frames.wide].width.toFixed(1)} &times; ${entry.frames.height.toFixed(1)} m`],
      ['coverage', `${(entry.shot.coverage * 100).toFixed(0)} %`, entry.shot.coverage > 0.05 ? 'ok' : 'warn'],
      ['mean luma', `${entry.shot.meanLuma.toFixed(3)}`],
      // Second: WHAT SHAPE, which is a property of this building alone. Both
      // planes are its own true widths, so the silhouette is exact even though
      // the picture is borrowed -- that split is the whole design.
      ['this cross', `${frames.x.width.toFixed(1)} &times; ${frames.z.width.toFixed(1)} m, ${frames.height.toFixed(1)} tall`],
      // How hard the one photograph is stretched to fit each plane. It is the
      // cost of sharing, and it is per-seed: a square hut pays 1.0x, a
      // longhouse pays four.
      ['stretch onto narrow', `${(Math.max(frames.x.width, frames.z.width) / Math.min(frames.x.width, frames.z.width)).toFixed(2)}&times;`],
      ['whole bank', `${CARD_COMBOS.length} layers &times; 64 KB = ${(bankKB / 1024).toFixed(2)} MB`, 'ok'],
    ])
  } else {
    table(cardEl, [['', 'pick a card tier to bake one']])
  }

  const nearAll = d2 * VISIBLE_BUILDINGS
  table(document.getElementById('village'), [
    [`${VISIBLE_BUILDINGS} visible at detail 2`, `${nearAll.toLocaleString()} tris`, nearAll <= 55000 ? 'ok' : 'warn'],
    ['of the frame budget', `${((nearAll / TRI_BUDGET) * 100).toFixed(1)} %`, nearAll / TRI_BUDGET < 0.2 ? 'ok' : 'warn'],
    ['draw calls it costs', `1 of ${CALL_BUDGET}`, 'ok'],
  ])
  document.getElementById('villagenote').innerHTML =
    `&sect;5 allots villages 55k triangles for 20 buildings. Anything much over that is not a ` +
    `budget overrun so much as a signal that a detail-2 tier is carrying ornament the eye cannot ` +
    `resolve at the distance it is drawn from.`
}

/** How far the warp moved the furthest vertex, measured between two builds of
 *  the same plan at the same detail. Returns null if the two disagree on vertex
 *  count, which would mean the tiers had stopped being the same building. */
function maxDisplacement(a, f) {
  if (!f) return 0
  const pa = a.getAttribute('position').array
  let m = 0
  for (let i = 0; i < pa.length; i += 3) {
    const q = f(pa[i], pa[i + 1], pa[i + 2])
    m = Math.max(m, Math.hypot(q[0] - pa[i], q[1] - pa[i + 1], q[2] - pa[i + 2]))
  }
  return m
}

/** Which array layers this building's vertices actually reference. Read off the
 *  geometry that is on screen, not rebuilt, so it cannot disagree with it. */
function usedLayers(geometry) {
  const attr = geometry.getAttribute('texLayer')
  const set = new Set()
  for (let i = 0; i < attr.count; i++) set.add(attr.getX(i))
  return [...set].sort((a, b) => a - b)
}

// --- tile strip -------------------------------------------------------------
//
// Read back out of the DataArrayTexture rather than re-run from tiles.js, so
// what the strip shows is literally the bytes the shader samples. If a tile is
// wrong on the wall it is wrong here too, which is the only way this panel is
// worth the space it takes.

function drawTiles() {
  const names = {
    [LAYER.TIMBER_BEAM]: 'beam', [LAYER.TIMBER_HEWN]: 'board', [LAYER.TIMBER_PLANK]: 'plank',
    [LAYER.THATCH]: 'thatch', [LAYER.SHINGLE]: 'shake', [LAYER.ROOF_TILE]: 'pantile',
    [LAYER.STONE]: 'stone', [LAYER.PLASTER]: 'plaster',
    [LAYER.THATCH_FRINGE]: 'fringe', [LAYER.GLASS]: 'glass', [LAYER.IRON]: 'iron',
    [LAYER.RUNE]: 'rune', [LAYER.DOOR]: 'door',
  }
  const host = document.getElementById('tiles')
  const stride = TEX_SIZE * TEX_SIZE * 4
  for (const [layerStr, name] of Object.entries(names)) {
    const layer = Number(layerStr)
    const fig = document.createElement('figure')
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = TEX_SIZE
    const ctx = canvas.getContext('2d')
    const img = ctx.createImageData(TEX_SIZE, TEX_SIZE)
    const src = textureArray.image.data.subarray(layer * stride, (layer + 1) * stride)
    // Composite over mid grey: the alpha-cut sheets are otherwise invisible.
    for (let i = 0; i < TEX_SIZE * TEX_SIZE; i++) {
      const a = src[i * 4 + 3] / 255
      for (let c = 0; c < 3; c++) img.data[i * 4 + c] = src[i * 4 + c] * a + 90 * (1 - a)
      img.data[i * 4 + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
    const cap = document.createElement('figcaption')
    const m = TILE_METRES[layer]
    cap.textContent = m ? `${name} ${m}m` : name
    cap.title = m
      ? `one UV tile covers ${m} m of wall`
      : 'decal sheet -- addressed by island, never scaled'
    fig.append(canvas, cap)
    host.appendChild(fig)
  }
}

// --- controls ---------------------------------------------------------------

/** A slider row bound to one key of one object. Shared by the character block
 *  and the proportion block, which differ only in what they write to. */
function sliderRow(host, defs, store, extraClass, onChange) {
  const readouts = {}
  for (const [key, min, max, step, help] of defs) {
    const row = document.createElement('div')
    row.className = `row${extraClass ? ` ${extraClass}` : ''}`
    row.innerHTML =
      `<label title="${help}">${key}</label>` +
      `<input type="range" min="${min}" max="${max}" step="${step}" value="${store[key]}" />` +
      `<span class="v"></span>`
    const input = row.querySelector('input')
    const out = row.querySelector('.v')
    readouts[key] = { input, out }
    // A step of 1 or more means the value is a count or an angle, not a
    // multiplier, and "78.00" in a 46px column is three characters of nothing.
    const dp = step >= 1 ? 0 : 2
    readouts[key].dp = dp
    const show = () => { out.textContent = Number(store[key]).toFixed(dp) }
    input.addEventListener('input', () => {
      store[key] = Number(input.value)
      show()
      onChange?.(key)
      refresh()
    })
    show()
    host.appendChild(row)
  }
  return readouts
}

const picksEl = document.getElementById('picks')
const pickDefs = [
  ['kind', Object.keys(KINDS), 'what the building is for. Sets area, height, and which styles are legal'],
  ['shape', ['auto', 'single', 'outshut', 'ell', 'tee', 'wing'], 'how the masses combine. Not every kind allows every shape -- auto picks a legal one'],
  ['style', ['auto', ...WALL_STYLES], 'wall treatment. ONE per building: mixing them makes it read as several buildings shoved together'],
  ['roof', ['auto', ...ROOF_KINDS], 'slate is not a texture -- it is the shake tile at a cold tint. pantile is, because a scallop is a shape'],
  ['detail', ['2', '1', '0', 'cross'], 'which LOD tier to build. 2 is what you see inside 60 m; 1 keeps the massing and the warp and drops the joinery. cross is not a mesh -- it is two planes at this building\'s own true widths wearing a photograph of a stand-in cottage in the same wall style and roof, and it draws beside detail 0 so you can see where it stops matching'],
]
for (const [key, options, help] of pickDefs) {
  const row = document.createElement('div')
  row.className = 'prow'
  row.innerHTML =
    `<label title="${help}">${key}</label>` +
    `<select>${options.map((o) => `<option value="${o}">${o}</option>`).join('')}</select>`
  const sel = row.querySelector('select')
  sel.value = String(picks[key])
  sel.addEventListener('change', () => {
    // A mesh tier is a NUMBER, because that is what buildBuilding2 takes; the
    // two card tiers stay strings, and `cardTier()` tells them apart by that.
    picks[key] = key === 'detail' && /^\d+$/.test(sel.value) ? Number(sel.value) : sel.value
    // A kind whitelists its shapes and styles, so switching kind can strand an
    // explicit pick on something illegal. Fall back to auto rather than
    // silently building something the grammar forbids.
    if (key === 'kind') {
      const K = KINDS[picks.kind]
      if (picks.shape !== 'auto' && !K.shapes.includes(picks.shape)) setPick('shape', 'auto')
      if (picks.style !== 'auto' && !K.styles.includes(picks.style)) setPick('style', 'auto')
    }
    refresh()
  })
  picksEl.appendChild(row)
}
function setPick(key, value) {
  picks[key] = value
  picksEl.querySelectorAll('select')[pickDefs.findIndex((d) => d[0] === key)].value = value
}

const charReadouts = sliderRow(document.getElementById('character'), CHARACTER, chars, 'master')
const readouts = sliderRow(document.getElementById('sliders'), SLIDERS, params, '', (key) => {
  if (key === 'slope') reshapeGround()
})

const seedInput = document.getElementById('seed')
seedInput.addEventListener('input', () => {
  params.seed = Number(seedInput.value) || 0
  refresh()
})
document.getElementById('reroll').addEventListener('click', () => {
  params.seed = Math.floor(Math.random() * 100000)
  seedInput.value = params.seed
  refresh()
})

function toggle(id, get, set) {
  const btn = document.getElementById(id)
  btn.classList.toggle('on', get())
  btn.addEventListener('click', () => {
    set(!get())
    btn.classList.toggle('on', get())
    refresh()
  })
}
toggle('gallery', () => galleryMode, (v) => {
  galleryMode = v
  const s = rebuild()
  if (v) {
    const half = Math.hypot((GALLERY_COLS * s.spacing) / 2, (GALLERY_ROWS * s.spacing) / 2)
    const dist = (half / Math.tan((camera.fov * Math.PI) / 360)) * 1.1
    controls.target.set(0, 2, 0)
    camera.position.set(0, dist * 0.7, dist * 0.8)
  } else {
    controls.target.set(0, s.hero.stats.ridgeY * 0.45, 0)
    camera.position.set(9, 5.5, 12)
  }
})
toggle('ghost', () => ghostMode, (v) => {
  ghostMode = v
  // Pull back and swing the target between the pair, or the twin lands off
  // screen and the button looks like it did nothing.
  if (v) {
    controls.target.set(-2.5, 2, 0)
    camera.position.set(6, 6, 17)
  } else {
    controls.target.set(0, 2, 0)
    camera.position.set(9, 5.5, 12)
  }
})
toggle('grid', () => showGrid, (v) => { showGrid = v })
toggle('wire', () => wireframe, (v) => { wireframe = v })
toggle('spin', () => controls.autoRotate, (v) => { controls.autoRotate = v })

document.getElementById('reset').addEventListener('click', () => {
  Object.assign(params, DEFAULTS)
  Object.assign(chars, CHAR_DEFAULTS)
  for (const [key] of SLIDERS) {
    readouts[key].input.value = params[key]
    readouts[key].out.textContent = Number(params[key]).toFixed(readouts[key].dp)
  }
  for (const [key] of CHARACTER) {
    charReadouts[key].input.value = chars[key]
    charReadouts[key].out.textContent = Number(chars[key]).toFixed(charReadouts[key].dp)
  }
  reshapeGround()
  refresh()
})

// --- run --------------------------------------------------------------------

function resize() {
  const w = stage.clientWidth
  const h = stage.clientHeight
  renderer.setSize(w, h)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}
addEventListener('resize', resize)
resize()

drawTiles()
reshapeGround()
refresh()

let last = performance.now()
renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dt = (now - last) / 1000
  last = now
  controls.update(dt)
  renderer.render(scene, camera)
})
