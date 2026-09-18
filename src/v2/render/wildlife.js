// ---------------------------------------------------------------------------
// THE WILDLIFE: the moor stag, the red fox and the snow hare, wandering the
// open ground. One of each per 3000 square metres, out to a RADIUS set by the
// furthest any of them is drawn from.
//
// PLACEMENT IS A PURE FUNCTION OF POSITION, the same contract the frogs keep:
// each TILE-metre tile rolls its animals from its own seed (critters.js
// tileSeed), so the same hollow holds the same stag every visit and nothing is
// stored between visits. A candidate stands only where SHE could stand -- the
// seat test is walk.js, the very surface the player walks and the teleport arc
// flies against, so an animal is never on a face she could not reach and never
// wades. It then wanders from there on a TETHER_M leash, because an animal that
// truly roamed would walk out of its tile and be deleted as scenery the moment
// the tile unloaded.
//
// BEHAVIOUR IS THE CLIP LIBRARY, SPELT OUT. An animal finishes what it was
// doing and picks the next thing by weight (SPECIES.acts), and an activity is a
// queue of (clip, seconds) steps rather than a state machine, because that is
// what the library actually is: a graze is eat-down, then a run of eat-loop
// chews, then eat-up, three clips authored to chain key-for-key. A rest plays
// `sit` or `lie` ONCE -- each is a whole round trip, down, hold and up, so
// looping one would be an animal bobbing up and down on the spot. A roam plays
// a gait, and the ground under it then moves at exactly the speed the clip's
// stride was built for (the shipper's `gait` extras), so the feet do not skate:
// that is why each species has its own gait weights, a fox's walk being a slow
// enough clip that a fox which mostly walked would look becalmed. A hare never
// walks or trots: its two gaits are the half-bound -- both hinds pushing off
// together, both fores catching -- at a saunter (`hop`) and flat out (`bound`),
// which are two clips and not one played at two rates because a hop is
// ballistic and a slowed clip floats.
//
// SHE IS FURNITURE. An animal takes no notice of her at any distance -- it
// grazes with her standing over it. Noticing her is a later job.
//
// IT TURNS, IT DOES NOT SNAP. `heading` is where a body faces and `aim` is
// where it wants to face; the gap closes at TURN_RATE and never faster, so
// every turn is one you can watch. An animal makes ground only in the direction
// it is actually facing, so a beast mid-turn slows and one turning back on
// itself pivots on the spot.
//
// NIGHT PUTS THEM DOWN. `dayness` is the world's one day scalar (main.js, the
// sun's own elevation) and it weights the roll: at full dark a rest is twice as
// likely to be the next thing an animal does as it is at noon.
//
// A SPAWN IS NOT AN ANIMAL. A tile's roll gives SPAWNS -- where a body stands
// when nothing has moved it, and what size it is -- and a spawn is
// woken into a live animal (a slot, with a position it has wandered to and an
// activity queue) only inside its card range, the outermost rung of the ladder.
// Past that it is not drawn AND NOT SIMULATED: nothing walks, turns, probes the
// ground or picks anything. Its wandered position is remembered until she is
// CULL_KEEP past that range, and past that the slot goes back in the pool and
// the next waking places it at home again. So the work is proportional to the
// animals she can actually see and not to the tiles that happen to be loaded,
// and an animal she turns her back on for a moment is exactly where she left it.
//
// DRAWN AS A PUPPET, THEN AS A CARD. A woken animal near enough for a mesh is
// its own skeleton (a clone of the shipped one) with a mixer on it, drawn as
// whichever of the file's four skinned tiers the ladder's rungs call for
// (critters.js critterTier). Under those four is one more rung, twice as far,
// where it is one spun quad in its species' InstancedMesh instead: at 100 m a
// stag is a dozen pixels tall and a photograph of it is the mesh, and what the
// rung buys is that she sees the herd she is walking toward rather than watching
// it appear. The card still walks, turns, grazes and goes home -- it is the same
// animal, drawn cheaper -- it simply has no skeleton and no mixer, so a distant
// herd costs a slot and four vertices each and nothing else.
//
// NOTHING POPS, at any of those edges. Every step of the ladder is a dissolve
// (render/puppet.js), and so is the handover between the last mesh rung and the
// card: the two read the same pixel hash and keep opposite halves of it, the
// mesh through the puppet's uCut and the card through its `aCardFade`
// attribute, driven from the same ramp on the same frame. A TILE UNLOAD is a
// dissolve too, so an animal whose tile goes while it is still in sight leaves
// its puppet behind to fade where it stood (`fading`); a card's tile cannot go
// while it is drawn, because RADIUS is set past the furthest card range. The
// exception is `place()`, the terrain rebuild, where the ground an animal was
// standing on no longer exists and there is nothing to fade on.
//
// THE PRICE is a draw call and a skeleton for each animal in MESH range -- a
// dozen in the live world, twenty at the pool's cap, doubled per eye in XR while
// the skeletons are not -- plus one instanced draw call a species for every card
// behind them. Each of those draws is a bone texture re-uploaded, so the mesh
// range and not the herd is what the layer costs; the settled ones at least
// share one material a species, which is why no animal wears a colour of its
// own (puppet.js makePuppetMaterials). design/27-creature-pipeline.md has the
// numbers.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import {
  CARD_RUNGS, CRITTER_GLB, LOD_RUNGS, SPUN_VIEWS, bakeCritterCard, createCritterCardMaterial, critterTier,
  cullRange, forgetRange, makeCardFadeAttribute, setCritterCard, spunBounds, tileSeed, walkTiles,
} from './critters.js'
import { LOD_FADE_S, Puppet, groundFeet, loadSkinnedAsset, makePuppetMaterials, makeSettledMaterial } from './puppet.js'

export const TILE = 32
// The tallest body the placement is sized to hold, in metres. Nothing here is
// near it -- a stag's largest extent is under three -- but a spawn that is not
// placed is an animal that pops in when the tile arrives rather than when the
// ladder says so, and the headroom is what lets a bigger creature join this
// layer without the radius being the thing that quietly clips it.
export const CARD_BODY_M = 4
// Tiles whose centre is within this of her are grown, so the furthest a spawn
// can be is this plus half a tile's diagonal. Set past the card range of the
// tallest body the layer holds, so a card is never waiting on its tile.
export const RADIUS = Math.ceil(cullRange(CARD_BODY_M, CARD_RUNGS) + (TILE * Math.SQRT2) / 2)
// Animals per square metre of the commonest species, the hare; each species scales it by its `rate`.
export const DENSITY = 1 / 3000
// Slots a species gets, and puppets. A stag's card range covers 200 m, which at
// its rate is some dozen live stags before the seat test thins them, so the
// slot pool is sized for that crowd clustering hard. Puppets are the scarcer
// thing and are sized for the MESH range alone: a starved animal is not drawn.
export const MAX = 64
export const PUPPETS = 20

// Ground an animal will not stand on: steeper than this, or this close under the snow line.
export const MAX_SLOPE = (35 * Math.PI) / 180
export const SNOW_MARGIN = 10
// How far from where it was placed an animal may wander before it turns for home.
export const TETHER_M = 24

const STAND_S = [3, 12]
const ROAM_S = [4, 14]
const ALERT_S = [2, 6]
const DIG_S = [3, 9]
// Chews of `eat-loop` between the head going down and coming back up.
const GRAZE_LOOPS = [2, 7]
// A roam aims by up to this from where the body faces, so a wander reads as a wander and not as a new random direction every bout.
const TURN = 1.4
// What a rest's weight is multiplied by at full dark. Half the ramp is spent before the sun is down, which is when a real herd starts settling.
export const NIGHT_REST = 2
// Radians a second a body may swing. A stag needs a second and a half to turn around, which is about what a stag needs.
export const TURN_RATE = 1.6
// Body lengths ahead the next seat is tested at.
const AHEAD = 1.5
// Frames between an animal's GROUND WORK -- the look-ahead seat test, the height
// under its feet and the normal it stands on -- by the rung it is drawn at,
// staggered across the animals by slot id so a herd never probes on one frame.
// Every one of those is a walk over every stone layer in the world (walk.js
// heightAt), which is the dominant per-animal cost and the only one worth
// bucketing: the mixer is 3 microseconds and the walk is what is left.
//
// BETWEEN PROBES IT WALKS THE TANGENT PLANE the last probe measured, rather than
// holding the height it had -- exact on a flat face, a centimetre out on a
// rolling one, and it is what makes a longer stride cost nothing visible. A
// creature on the card rung probes once every thirty-two frames and is a dozen
// pixels tall while it does.
export const PROBE_EVERY = [6, 8, 12, 16, 32]
// On the card rung an animal is stepped -- walked, turned, its activity run --
// only every CARD_EVERY frames, on the dt banked between, and its card is
// pushed as it last was on the others: at a dozen pixels a stride four frames
// long is under a pixel. The card rung's probe cadence is a multiple, so the
// probe lands on a stepped frame.
export const CARD_EVERY = 4
// Her head must move this far before the tiles are walked again: a tile enters or leaves only when she does, and the walk is a few hundred keys.
const WALK_M = 4
// Seconds one clip takes to give way to the next. Nothing to do with the LOD dissolve, which is render/puppet.js's LOD_FADE_S.
const FADE_S = 0.25

// Every clip the shipped file must carry. One-shots play once and hold their last frame; the rest cycle.
export const CLIPS = ['idle', 'alert', 'walk', 'trot', 'run', 'hop', 'bound', 'sit', 'lie', 'dig', 'eat-down', 'eat-loop', 'eat-up', 'dead']
export const ONE_SHOT = new Set(['eat-down', 'eat-up', 'sit', 'lie', 'dead'])
// A seized body is drawn about the point the talons hold -- the top of its
// back, this fraction of its STANDING height up, which is where the `dead`
// pose's sagging spine tops out (the stag's back, hips tilted down and neck
// hanging, measures 0.50 of the idle height) -- and a body laid on the nest is
// rolled onto its flank and lifted this fraction of its width so the flank and
// not the spine rests on the floor.
export const GRIP = 0.5
export const LAIN = 0.35
// The clips whose four feet stay put, so a standing body's feet are put on the
// ground under each (puppet.js FootIK). Measured off the shipped clips: a dig
// lifts a forefoot, a sit and a lie fold the legs, and no gait is planted.
export const PLANTED = new Set(['idle', 'alert', 'eat-down', 'eat-loop', 'eat-up'])

/**
 * The three of them. `acts` and `gaits` are (name, weight) pairs rolled when an
 * animal needs something new to do; `rate` is the species' share of DENSITY;
 * the size of a body is its length, the shipped figure times `scale` times a
 * roll of `vary` either way, and no two animals are the same size. None of them
 * wears a colour of its own: a skinned body can only take one through a uniform
 * and a uniform costs a material an animal (puppet.js makePuppetMaterials).
 */
export const SPECIES = [
  {
    key: 'stag', glb: CRITTER_GLB.stag, vary: 0.25, scale: 1, rate: 0.5,
    acts: [['graze', 5], ['stand', 3], ['roam', 4], ['rest', 1]],
    gaits: [['walk', 7], ['trot', 3]],
  },
  {
    key: 'fox', glb: CRITTER_GLB.fox, vary: 0.25, scale: 1, rate: 0.5,
    acts: [['roam', 5], ['stand', 3], ['dig', 2], ['rest', 2], ['graze', 1]],
    gaits: [['walk', 2], ['trot', 8]],
  },
  {
    key: 'hare', glb: CRITTER_GLB.hare, vary: 0.25, scale: 1, rate: 1,
    acts: [['graze', 5], ['stand', 4], ['roam', 4], ['dig', 1], ['rest', 1]],
    gaits: [['hop', 6], ['bound', 4]],
  },
]

const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()
/** The shortest way round from `a` to `b`, in (-pi, pi]. */
const swingTo = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a))
/** One name out of (name, weight) pairs. */
function weighted(rand, pairs) {
  let roll = rand() * pairs.reduce((sum, p) => sum + p[1], 0)
  for (const [name, w] of pairs) if ((roll -= w) < 0) return name
  return pairs[pairs.length - 1][0]
}

const UP = new THREE.Vector3(0, 1, 0)
const _quat = new THREE.Quaternion()
const _pos = new THREE.Vector3()
const _scl = new THREE.Vector3()
const _mat = new THREE.Matrix4()
// A quarter roll about the body's own forward axis: a standing body laid on its flank.
const _lay = new THREE.Matrix4().makeRotationX(Math.PI / 2)
const _hang = new THREE.Matrix4()
const _trunk = { x: 0, z: 0, r: 0 }
const _norm = { x: 0, y: 1, z: 0 }

/**
 * A shipped quadruped (tools/creatures/ship-quadruped.mjs): the ladder, the
 * skeleton, the clips and the colour map as render/puppet.js wants them, plus
 * the shipper's extras spread on top -- the body's length and turned span, and
 * the ground speed of each gait in the file's own units.
 *
 * The vertices themselves are still on the rig's diagonal; the frame that
 * squares them up rides on the ROOT JOINT, so anything drawn through the
 * skeleton is already straight and nothing here has to know about it.
 */
export async function loadQuadrupedGlb(url) {
  const asset = await loadSkinnedAsset(url, { tiers: LOD_RUNGS, clips: CLIPS, extras: 'quadruped' })
  if (!(asset.extras.span > 0)) throw new Error(`${url}: no turned span in its extras -- re-ship it`)
  if (asset.extras.legs?.length !== 4) throw new Error(`${url}: no four legs in its extras -- re-ship it`)
  return { ...asset, ...asset.extras }
}

export class Wildlife {
  /**
   * @param height  V2Height: snowLineAt
   * @param water   WaterSurfaces: isSubmerged -- an animal does not wade
   * @param opts.walk  WalkSurface: heightAt, normalAt, obstacleAt. The ground she walks is the ground they walk.
   * @param opts.assets a loaded asset per species, keyed by SPECIES.key, for a gate; the world fetches the GLBs
   */
  constructor(scene, height, water, { seed = 1, walk, assets = null } = {}) {
    if (!height || typeof height.snowLineAt !== 'function') throw new Error('Wildlife needs a height field with snowLineAt')
    if (!water || typeof water.isSubmerged !== 'function') throw new Error('Wildlife needs WaterSurfaces, for isSubmerged')
    if (!walk || typeof walk.heightAt !== 'function' || typeof walk.normalAt !== 'function' || typeof walk.obstacleAt !== 'function') {
      throw new Error('Wildlife needs the WalkSurface, for heightAt, normalAt and obstacleAt')
    }
    this.height = height
    this.water = water
    this.walk = walk
    this.seed = seed
    this.rand = mulberry32(seed ^ 0x2b91)

    this.batch = new THREE.Group()
    this.batch.name = 'v2-wildlife'
    scene.add(this.batch)
    // Every material the world's lighting patches; two programs a species, the dissolve's cut being a uniform and not a variant.
    this.materials = []
    // The world's day scalar, written by update(). Full day until the clock says otherwise, so a gate that never passes one gets noon.
    this.dayness = 1

    this.species = SPECIES.map((sp) => {
      // ONE settled material for the whole species, and a fade pair per puppet.
      // A settled animal is the usual case and a fading one lasts FADE_S, so a
      // frame of a dozen drawn stags is one material change and not a dozen.
      const plain = makeSettledMaterial(`wildlife-${sp.key}`)
      this.materials.push(plain)
      const materials = []
      for (let i = 0; i < PUPPETS; i++) {
        const mats = makePuppetMaterials(`wildlife-${sp.key}`, plain)
        materials.push(mats)
        this.materials.push(mats.in, mats.out)
      }
      // Built here and not with the asset, because the world patches every
      // material with its lighting the moment the layer exists and the GLBs
      // land long after. The quad and the picture arrive in setAssets and
      // bakeCards; until the picture does, the mesh draws nothing.
      const cardMaterial = createCritterCardMaterial(`wildlife-${sp.key}`, { billboard: true, fade: true, hue: false })
      this.materials.push(cardMaterial)
      const slots = []
      for (let i = 0; i < MAX; i++) {
        slots.push({
          id: i, sp: null, spawn: null,
          x: 0, y: 0, z: 0, homeX: 0, homeZ: 0, heading: 0, aim: 0, size: 1, k: 1,
          nx: 0, ny: 1, nz: 0,
          // The activity, the steps it has left, the clip playing and how long it holds; `dur` is that step's whole length, so a puppet taken mid-step joins the clip where it already is, and `cycle` the clip's own length, for the ear's footfall clock. `cue` counts steps, and is how a puppet tells a fresh step from the one it is playing.
          act: 'stand', queue: [], clip: 'idle', left: 0, dur: 0, cycle: 0, cue: 0, speed: 0,
          // The ladder rung it is on, CARD_RUNGS being past the last rung and so neither drawn nor simulated.
          lod: CARD_RUNGS, puppet: null,
          // Whether the card is the thing this animal should be drawing, and how
          // far through the dissolve into or out of that it is (1 is settled).
          cardWant: false, cardP: 1,
          // Where its card was last drawn: pushed again on the frames a card animal is not stepped, and the dissolve on a seized one's drop.
          cardMat: new THREE.Matrix4(),
          // The dt banked on the card rung between steps.
          held: 0,
        })
      }
      return { ...sp, plain, materials, cardMaterial, cardMesh: null, cardFade: null, cardN: 0, slots, free: slots.slice(), puppets: [], freePuppets: [], asset: null }
    })

    this.tiles = new Map()
    // Where her head was when the tiles were last walked.
    this.walkedX = Infinity
    this.walkedZ = Infinity
    this.frame = 0
    this.loaded = false
    // Candidates whose seat held but that found no free slot; animal-frames in sight with no free puppet, and so not drawn.
    this.overflow = 0
    this.starved = 0
    // Puppets outliving the animal they were: whatever unloaded with its tile, dissolving on the spot.
    this.fading = []
    this.fadingCards = []

    if (assets) {
      this.setAssets(assets)
      this.ready = Promise.resolve(true)
    } else {
      this.ready = this.load()
    }
  }

  async load() {
    const loaded = await Promise.all(this.species.map((sp) => loadQuadrupedGlb(sp.glb)))
    this.setAssets(Object.fromEntries(this.species.map((sp, i) => [sp.key, loaded[i]])))
    return true
  }

  /** One loaded asset per species, keyed by SPECIES.key. */
  setAssets(assets) {
    for (const sp of this.species) {
      const asset = assets[sp.key]
      if (!asset) throw new Error(`Wildlife.setAssets: nothing for ${sp.key}`)
      if (!(asset.span > 0) || !(asset.width > 0) || !(asset.height > 0)) throw new Error(`Wildlife.setAssets: ${sp.key} has no body extents -- re-ship it`)
      sp.asset = asset
      // The ladder's rungs are a ratio of the body's LARGEST extent (critters.js), and `size` is its length: for a four-legged animal those are the same thing, and `bulk` says so rather than assuming it.
      sp.bulk = Math.max(asset.span, asset.width, asset.height) / asset.span
      sp.durations = Object.fromEntries(asset.clips.map((c) => [c.name, c.duration]))
      sp.plain.map = asset.map
      sp.plain.needsUpdate = true
      for (const mats of sp.materials) {
        for (const m of [mats.in, mats.out]) {
          m.map = asset.map
          m.needsUpdate = true
        }
        sp.puppets.push(new Puppet(asset, mats, { clipFade: FADE_S, oneShot: ONE_SHOT }))
      }
      sp.freePuppets = sp.puppets.slice()

      // The card rung's quad, in the same unit frame the puppet's meshes are in
      // and sized by the shipper's own measurements of the turned body, so one
      // `k` scales both and the handover is the same animal at the same size.
      // As wide as the body's longest side (spunBounds), since the one picture
      // stands in for every side of it.
      const mesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), sp.cardMaterial, MAX)
      mesh.name = `v2-wildlife-${sp.key}-cards`
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      // The instances move every frame and a bounding sphere over them would have to be rebuilt every frame to say anything true.
      mesh.frustumCulled = false
      mesh.count = 0
      // Nothing to draw until bakeCards has photographed the body: an unbaked card is a white quad, which is worse than no card.
      mesh.visible = false
      setCritterCard(mesh, spunBounds({ halfX: asset.span / 2, halfZ: asset.width / 2, height: asset.height }), SPUN_VIEWS)
      sp.cardFade = makeCardFadeAttribute(mesh, MAX)
      sp.cardMesh = mesh
      this.batch.add(mesh)
    }
    this.loaded = true
  }

  /**
   * Photograph each species for its card rung: the body posed in `idle` through
   * a throwaway puppet, because a quadruped's vertices sit on the rig's diagonal
   * and mean nothing until the bones have moved them. Needs the renderer, so the
   * world calls it once the GLBs have landed.
   */
  bakeCards(renderer) {
    if (!this.loaded) throw new Error('Wildlife.bakeCards: the GLBs have not landed')
    for (const sp of this.species) {
      const asset = sp.asset
      const flat = new THREE.MeshBasicMaterial({ map: asset.map, toneMapped: false })
      // Puppet wants the three-material shape; unlit for the photograph, the same one for every state it might pick.
      const p = new Puppet(asset, { plain: flat, in: flat, out: flat, uCut: { value: 1 } }, { clipFade: FADE_S, oneShot: ONE_SHOT })
      p.show(0)
      p.play('idle')
      p.step(0)
      p.group.updateMatrixWorld(true)
      const bounds = spunBounds({ halfX: asset.span / 2, halfZ: asset.width / 2, height: asset.height })
      sp.cardMaterial.map = bakeCritterCard(renderer, p.group, asset.map, bounds, SPUN_VIEWS)
      sp.cardMaterial.needsUpdate = true
      sp.cardMesh.visible = true
      p.release()
      p.skeleton.dispose()
      flat.dispose()
    }
  }

  /**
   * The ground at (x, z) an animal may stand on, or null: the walk surface (the
   * field, or the top of a stone she could step onto), gentle, dry, clear of a
   * trunk and below the cold. The normal there goes into `_norm`.
   */
  seat(x, z) {
    const y = this.walk.heightAt(x, z)
    if (this.water.isSubmerged(x, z, y)) return null
    if (y > this.height.snowLineAt(x, z) - SNOW_MARGIN) return null
    if (this.walk.obstacleAt(x, z, _trunk)) return null
    this.walk.normalAt(x, z, undefined, _norm)
    if (Math.acos(Math.min(1, _norm.y)) > MAX_SLOPE) return null
    return y
  }

  /**
   * A tile's spawns: where each animal stands before anything has moved it, and
   * what it is. Rolling one costs a seat test and nothing else -- no slot, no
   * puppet, no activity -- because most of a tile's spawns are asleep most of
   * the time, and a spawn asleep costs a distance.
   */
  _enter(tx, tz) {
    const rand = mulberry32(tileSeed(tx, tz, this.seed))
    const t = { tx, tz, spawns: [] }
    for (const sp of this.species) {
      const want = DENSITY * sp.rate * TILE * TILE
      const n = Math.floor(want) + (rand() < want % 1 ? 1 : 0)
      for (let i = 0; i < n; i++) {
        const x = (tx + rand()) * TILE
        const z = (tz + rand()) * TILE
        const size = sp.asset.sizeM * sp.scale * (1 + (rand() * 2 - 1) * sp.vary)
        const heading = rand() * Math.PI * 2
        const y = this.seat(x, z)
        if (y === null) continue
        const lodSize = size * sp.bulk
        t.spawns.push({
          sp, x, y, z, nx: _norm.x, ny: _norm.y, nz: _norm.z, size, heading,
          // Where the mesh gives way to the card, where the card gives way to nothing, and where the placement stops being worth remembering.
          cull: cullRange(lodSize), card: cullRange(lodSize, CARD_RUNGS), forget: forgetRange(lodSize, CARD_RUNGS),
          // Taken by a dragon (`seize`): not woken again while its tile is loaded. The tile re-rolls it on the next visit.
          lodSize, slot: null, dead: false,
        })
      }
    }
    return t
  }

  /** A spawn woken into a live animal, standing at home and already busy, or null when the pool is out of slots. */
  _wake(s) {
    const c = s.sp.free.pop()
    if (!c) { this.overflow++; return null }
    c.sp = s.sp
    c.spawn = s
    c.x = c.homeX = s.x
    c.z = c.homeZ = s.z
    c.y = s.y
    c.nx = s.nx; c.ny = s.ny; c.nz = s.nz
    c.size = s.size
    c.k = s.size / s.sp.asset.span
    c.heading = c.aim = s.heading
    c.lod = CARD_RUNGS
    c.puppet = null
    c.cardWant = false
    c.cardP = 1
    c.held = 0
    this._pick(c)
    // Staggered into its activity, so a tile's animals do not all bow into a graze on the same frame.
    c.left *= this.rand()
    s.slot = c
    return c
  }

  /**
   * A live animal back to a spawn: the slot returns to the pool and where it had
   * wandered to is forgotten, so the next waking puts it at home. `fade` leaves
   * its puppet behind to dissolve on the spot -- the animal is gone, its body is
   * not -- and is false only where there is nothing left to fade on.
   */
  _sleep(s, fade = true) {
    const c = s.slot
    if (!c) return
    if (fade && c.puppet) {
      c.puppet.show(-1)
      this.fading.push({ sp: c.sp, puppet: c.puppet })
      c.puppet = null
    } else {
      this._releasePuppet(c)
    }
    c.spawn = null
    s.slot = null
    s.sp.free.push(c)
  }

  _leave(t, fade = true) {
    for (const s of t.spawns) this._sleep(s, fade)
    t.spawns.length = 0
  }

  /** Rebuild every tile around (cx, cz). Boot, and whenever the ground moves under her. Nothing fades: the ground a body was standing on is not there to fade on. */
  place(cx, cz) {
    for (const t of this.tiles.values()) this._leave(t, false)
    for (const f of this.fading) this._park(f.puppet, f.sp)
    this.fading.length = 0
    this.fadingCards.length = 0
    this.tiles.clear()
    this.overflow = 0
    if (!this.loaded) return
    // The cards go with them: the buffers hold last frame's animals, and the next frame refills them from the tiles this line is about to grow.
    for (const sp of this.species) { sp.cardN = 0; sp.cardMesh.count = 0 }
    walkTiles(this.tiles, cx, cz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t))
    this.walkedX = cx
    this.walkedZ = cz
  }

  get stats() {
    const alive = {}
    const puppets = {}
    // Drawn animals and the triangles they cost, split by MESH rung, so which rung a creature is on is a number to read and not a thing to squint at. The card rung has no tier and is counted on its own.
    const lod = Array.from({ length: LOD_RUNGS }, () => ({ n: 0, tris: 0 }))
    let cards = 0
    for (const sp of this.species) {
      alive[sp.key] = MAX - sp.free.length
      puppets[sp.key] = sp.puppets.length - sp.freePuppets.length
      cards += sp.cardN
      for (const c of sp.slots) {
        if (c.spawn === null || c.lod >= LOD_RUNGS) continue
        lod[c.lod].n++
        lod[c.lod].tris += sp.asset.tiers[c.lod].index.count / 3
      }
    }
    return { alive, puppets, lod, cards, tiles: this.tiles.size, overflow: this.overflow, starved: this.starved }
  }

  /**
   * Every animal living this frame, for the ear (audio/ambience.js): the slots
   * themselves, with x, y, z, size, clip, cycle and speed on them, `speed > 0`
   * meaning it is walking a gait. A hidden layer is frozen and lists nothing;
   * nor does an animal past its last rung, which stands still whatever clip it
   * was on.
   */
  bodies(into) {
    if (!this.batch.visible) return into
    for (const sp of this.species) {
      for (const c of sp.slots) if (c.spawn !== null && c.lod < CARD_RUNGS) into.push(c)
    }
    return into
  }

  // -------------------------------------------------------------------------
  // PREY. The dragons (render/dragons.js) hunt the stags, and what they need
  // of this layer is four verbs: find one, take it, draw it hanging from the
  // talons and let it go. A taken stag is a slot with no spawn: it is off every
  // tile, so nothing here walks it, tiers it or lists it for the ear, and its
  // spawn is marked dead so the tile does not wake a second stag where the
  // first stood. The slot and its puppet stay this layer's -- the pool logic
  // does not leak -- and come back to the pools on `drop`.
  // -------------------------------------------------------------------------

  /** The nearest live stag within `range` of (x, z), or null. A live stag is one this layer is simulating: on a rung, not asleep on its spawn. */
  prey(x, z, range) {
    let best = null
    let bestD = range * range
    for (const sp of this.species) {
      if (sp.key !== 'stag') continue
      for (const c of sp.slots) {
        if (c.spawn === null || c.lod >= CARD_RUNGS) continue
        const d = (c.x - x) ** 2 + (c.z - z) ** 2
        if (d < bestD) { bestD = d; best = c }
      }
    }
    return best
  }

  /**
   * Take a live stag out of the world as cargo: the slot itself, gone limp
   * (`dead`, which holds its last frame). Its spawn is not woken again while its
   * tile is loaded; a spawn whose tile is re-rolled on a later visit is a new stag.
   */
  seize(c) {
    if (c.spawn === null) throw new Error('Wildlife.seize: that animal is not in the world')
    const s = c.spawn
    s.dead = true
    s.slot = null
    c.spawn = null
    c.lodSize = s.lodSize
    c.act = 'dead'
    c.queue.length = 0
    c.clip = 'dead'
    c.cue++
    // Held from the clip's start, so a puppet taking it over mid-carry plays the slump and clamps.
    c.dur = c.left = c.sp.durations.dead
    c.cycle = c.dur
    c.speed = 0
    return c
  }

  /**
   * One frame of a seized stag drawn from `matrix` -- the carrier's talons, or
   * a point on the nest floor -- `dist` metres from her head: its own species'
   * mesh rungs while the ladder says mesh, and past them its card, standing
   * upright under the talons (or on the nest spot) for as long as the carrier
   * is drawn (`shown`) -- the kill's own card reach does not apply, because a
   * dragon she can see carrying nothing is the wrong picture at any range.
   * Hanging, the body's back is at the matrix and the rest of it sags below;
   * `lain`, the mesh is rolled onto its flank with the flank on the matrix.
   * Called after update() has filled the card buffers, so it appends to them.
   */
  carry(c, matrix, dist, dt, lain = false, shown = true) {
    if (c.spawn !== null || c.act !== 'dead') throw new Error('Wildlife.carry: that animal was not seized')
    const tier = critterTier(c.lodSize, dist, c.lod, LOD_RUNGS)
    c.lod = tier
    matrix.decompose(_pos, _quat, _scl)
    c.x = _pos.x; c.y = _pos.y; c.z = _pos.z
    const { width, height } = c.sp.asset
    // Only while the layer is stepped: with it hidden update() has not emptied the buffer this frame, and a card appended every frame would fill it.
    if (this.batch.visible) {
      this._wantCard(c, tier === LOD_RUNGS && shown)
      if (c.cardP < 1) c.cardP = Math.min(1, c.cardP + dt / LOD_FADE_S)
      if (c.cardWant || c.cardP < 1) {
        // Upright on the nest spot, or its feet GRIP of its height under the talons, where the mesh's would be.
        this._cardAt(c, lain ? c.cardMat.copy(matrix) : c.cardMat.multiplyMatrices(matrix, _hang.makeTranslation(0, -GRIP * height, 0)))
        this._commitCards(c.sp)
      }
    }
    if (tier >= LOD_RUNGS) {
      if (!c.puppet) return
      c.puppet.show(-1)
      c.puppet.step(dt)
      if (c.puppet.done) this._releasePuppet(c)
      return
    }
    const puppet = this._takePuppet(c)
    if (!puppet) return
    puppet.show(tier)
    puppet.play(c.clip, c.cue)
    // Carried, there is no ground under its feet.
    puppet.unplant()
    puppet.step(dt)
    // Body-local offsets, so the matrix's own scale and yaw carry them.
    const body = lain
      ? _mat.makeTranslation(0, LAIN * width, 0).multiply(_lay)
      : _mat.makeTranslation(0, -GRIP * height, 0)
    puppet.group.matrix.multiplyMatrices(matrix, body)
    puppet.group.matrixWorldNeedsUpdate = true
  }

  /** A seized stag let go: its body -- puppet or card -- dissolves where it is (or vanishes, with `fade` off, when the ground has gone) and the slot goes back to the pool. */
  drop(c, fade = true) {
    if (c.spawn !== null || c.act !== 'dead') throw new Error('Wildlife.drop: that animal was not seized')
    if (fade && c.puppet) {
      c.puppet.show(-1)
      this.fading.push({ sp: c.sp, puppet: c.puppet })
      c.puppet = null
    } else {
      this._releasePuppet(c)
    }
    if (fade && (c.cardWant || c.cardP < 1)) {
      // Where carry() last drew it; a card still arriving is sent out from as far as it got.
      this._wantCard(c, false)
      this.fadingCards.push({ sp: c.sp, mat: c.cardMat.clone(), p: c.cardP })
    }
    c.cardWant = false
    c.cardP = 1
    c.act = 'stand'
    c.lod = CARD_RUNGS
    c.sp.free.push(c)
  }

  // -------------------------------------------------------------------------
  // What an animal is doing.
  // -------------------------------------------------------------------------

  /** A fresh activity, rolled by the species' weights with the night's thumb on the resting one. */
  _pick(c) {
    const rest = 1 + (NIGHT_REST - 1) * (1 - this.dayness)
    this._begin(c, weighted(this.rand, c.sp.acts.map(([n, w]) => [n, n === 'rest' ? w * rest : w])))
  }

  /** `act` as a queue of (clip, seconds) steps, and its first step started. */
  _begin(c, act) {
    const d = c.sp.durations
    const q = c.queue
    q.length = 0
    switch (act) {
      case 'stand':
        q.push(['idle', between(this.rand, STAND_S)])
        break
      case 'graze': {
        const chews = Math.round(between(this.rand, GRAZE_LOOPS))
        q.push(['eat-down', d['eat-down']], ['eat-loop', chews * d['eat-loop']], ['eat-up', d['eat-up']])
        break
      }
      case 'rest': {
        // Each is a whole round trip -- down, hold, up -- so it is played once and timed by its own length.
        const clip = this.rand() < 0.5 ? 'sit' : 'lie'
        q.push([clip, d[clip]])
        break
      }
      case 'dig':
        q.push(['dig', between(this.rand, DIG_S)], ['alert', between(this.rand, ALERT_S)])
        break
      case 'roam':
        c.aim = c.heading + (this.rand() - 0.5) * TURN
        q.push([weighted(this.rand, c.sp.gaits), between(this.rand, ROAM_S)])
        break
      default:
        throw new Error(`Wildlife: no activity named ${act}`)
    }
    c.act = act
    this._step(c)
  }

  /** The queue's next step, or a fresh activity when it has run out. */
  _step(c) {
    const step = c.queue.shift()
    if (!step) { this._pick(c); return }
    c.clip = step[0]
    c.dur = step[1]
    c.left = step[1]
    c.cycle = c.sp.durations[c.clip]
    c.cue++
    const speed = c.sp.asset.gait[c.clip]
    c.speed = speed === undefined ? 0 : speed * c.k
  }

  /** Aim a quarter to three-quarters of a turn off where the body faces, either way. */
  _turnAway(c) {
    c.aim = c.heading + (this.rand() < 0.5 ? 1 : -1) * (Math.PI / 4 + this.rand() * Math.PI / 2)
  }

  /**
   * Ease the heading toward the aim, TURN_RATE at the most, and report how much
   * of a step that leaves: the cosine of the swing it still owes, so a body
   * three-quarters turned round makes no ground at all and pivots instead.
   */
  _turn(c, dt) {
    const swing = swingTo(c.heading, c.aim)
    c.heading += Math.sign(swing) * Math.min(Math.abs(swing), TURN_RATE * dt)
    return Math.max(0, Math.cos(swing))
  }

  /**
   * One frame of a moving animal: on a probe frame a look a body length and a
   * half ahead, then the turn, then a step along the heading. No seat there, or
   * past the tether, and it aims away -- so an animal never walks into the
   * water, up a crag or through a trunk, and never leaves the ground she could
   * reach herself. It is slowest exactly while it is turning hardest, which is
   * what keeps it inside the ground the probe cleared.
   */
  _walk(c, dt, probing) {
    if (probing) {
      const ahead = c.size * AHEAD
      const ax = c.x + Math.cos(c.heading) * ahead
      const az = c.z - Math.sin(c.heading) * ahead
      if (Math.hypot(ax - c.homeX, az - c.homeZ) > TETHER_M) {
        c.aim = Math.atan2(-(c.homeZ - c.z), c.homeX - c.x) + (this.rand() - 0.5) * (Math.PI / 2)
      } else if (this.seat(ax, az) === null) {
        this._turnAway(c)
      }
    }
    const d = c.speed * dt * this._turn(c, dt)
    c.x += Math.cos(c.heading) * d
    c.z -= Math.sin(c.heading) * d
  }

  _takePuppet(c) {
    const sp = c.sp
    if (!c.puppet) {
      const p = sp.freePuppets.pop()
      if (!p) { this.starved++; return null }
      c.puppet = p
      this.batch.add(p.group)
      // Joined where the step already is, so an animal that walks into range is not caught halfway through bowing into a graze it began a minute ago.
      p.play(c.clip, c.cue, c.dur - c.left)
    }
    return c.puppet
  }

  /** A puppet drawing nothing and back in its species' pool. */
  _park(p, sp) {
    p.release()
    this.batch.remove(p.group)
    sp.freePuppets.push(p)
  }

  /** Hand this animal's puppet back at once, without a fade. */
  _releasePuppet(c) {
    if (!c.puppet) return
    this._park(c.puppet, c.sp)
    c.puppet = null
  }

  /**
   * Ask for the card, or ask for it to go. A reversal mid-dissolve rewinds the
   * one already running rather than starting a third -- Puppet.show's rule, and
   * it has to be the same rule, because the two are halves of one dissolve.
   */
  _wantCard(c, on) {
    if (on === c.cardWant) return
    c.cardWant = on
    c.cardP = 1 - c.cardP
  }

  /**
   * This animal into its species' card buffer for this frame: where it stands,
   * which way it faces (the spin keeps the yaw, and reads the picture mirrored
   * for a body facing away), how big it is and its turn round the colour wheel.
   * On the world vertical, as the mesh it stands in for is.
   *
   * `aCardFade` is the dissolve, in material.js's FADE_FRAGMENT terms: positive
   * keeps the low side of the pixel hash and negative the high side. The card
   * arrives on the LOW side because the mesh it is replacing leaves through the
   * puppet's `out`, which keeps the high one, and it leaves on the high side
   * because the mesh arriving through `in` keeps the low one -- so between them
   * they cover every pixel exactly once and the silhouette never thins.
   */
  _drawCard(c) {
    _pos.set(c.x, c.y, c.z)
    _quat.setFromAxisAngle(UP, c.heading)
    _scl.setScalar(c.k)
    this._cardAt(c, c.cardMat.compose(_pos, _quat, _scl))
  }

  /** The card on `mat` -- a carried kill's is the carrier's matrix, not the slot's place and heading -- with the slot's dissolve. */
  _cardAt(c, mat) {
    this._pushCard(c.sp, mat, c.cardWant ? c.cardP : -(1 - c.cardP))
  }

  _pushCard(sp, mat, fade) {
    const i = sp.cardN++
    if (i >= MAX) throw new Error(`Wildlife: ${sp.key} has more cards this frame than the ${MAX} its buffer holds`)
    sp.cardMesh.setMatrixAt(i, mat)
    sp.cardFade.array[i] = fade
  }

  /** The card buffer's count and upload flags set to what has been pushed this frame. */
  _commitCards(sp) {
    sp.cardMesh.count = sp.cardN
    if (!sp.cardN) return
    sp.cardMesh.instanceMatrix.needsUpdate = true
    sp.cardFade.needsUpdate = true
  }

  /**
   * One frame: every animal stepped, and the ones big enough in her view given a
   * puppet. `dayness` is the world's day scalar, 1 at noon and 0 once the sun is
   * well down, and it is what makes them settle at night.
   */
  update(hx, hy, hz, dt, dayness = 1) {
    if (!this.loaded) return
    this.dayness = dayness
    if (Math.hypot(hx - this.walkedX, hz - this.walkedZ) > WALK_M) {
      walkTiles(this.tiles, hx, hz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t))
      this.walkedX = hx
      this.walkedZ = hz
    }
    this.frame++
    // The card buffers are refilled from nothing every frame: an instance in one is an animal on the card rung THIS frame, and the count is the whole of what is drawn.
    for (const sp of this.species) sp.cardN = 0

    // The bodies of animals that unloaded, finishing their dissolve where they stood. They do not walk, turn or pick anything: they are a fade.
    for (let i = this.fading.length - 1; i >= 0; i--) {
      const f = this.fading[i]
      f.puppet.step(dt)
      if (!f.puppet.done) continue
      this._park(f.puppet, f.sp)
      this.fading[i] = this.fading[this.fading.length - 1]
      this.fading.pop()
    }

    for (const t of this.tiles.values()) {
      for (const s of t.spawns) {
        if (s.dead) continue
        // Asleep, it is measured from home; awake, from wherever it has walked to.
        const live = s.slot
        const dx = (live ? live.x : s.x) - hx
        const dy = (live ? live.y : s.y) - hy
        const dz = (live ? live.z : s.z) - hz
        const d2 = dx * dx + dy * dy + dz * dz
        // Asleep and past its card range, it stays asleep: the ladder is not asked.
        if (!live && d2 > s.card * s.card) continue
        const dist = Math.sqrt(d2)
        // One rule decides all three: the rung it is drawn at, whether that rung is the card, and whether it is alive at all.
        const tier = critterTier(s.lodSize, dist, live ? live.lod : CARD_RUNGS, CARD_RUNGS)

        if (tier === CARD_RUNGS) {
          if (!live) continue
          // Past the last rung an animal stops dead: no walking, no turning, no picking. What is left is its body finishing the dissolve out, and then the wait to see whether she comes back before its placement is worth forgetting.
          live.lod = CARD_RUNGS
          this._wantCard(live, false)
          if (live.cardP < 1) {
            live.cardP = Math.min(1, live.cardP + dt / LOD_FADE_S)
            this._drawCard(live)
          }
          if (live.puppet) {
            live.puppet.show(-1)
            live.puppet.step(dt)
            if (live.puppet.done) this._releasePuppet(live)
          } else if (live.cardP >= 1 && dist > s.forget) {
            this._sleep(s)
          }
          continue
        }

        const c = live ?? this._wake(s)
        if (!c) continue
        c.lod = tier
        // A card animal with no puppet left dissolving against it is stepped every CARD_EVERY frames (see the constant); with one, every frame, for the fade.
        let step = dt
        if (tier === LOD_RUNGS && !c.puppet) {
          c.held += dt
          if ((this.frame + c.id) % CARD_EVERY !== 0) {
            if (c.cardWant || c.cardP < 1) this._cardAt(c, c.cardMat)
            continue
          }
          step = c.held
        }
        c.held = 0
        const probing = (this.frame + c.id) % PROBE_EVERY[tier] === 0
        c.left -= step
        if (c.left <= 0) this._step(c)
        const wasX = c.x
        const wasZ = c.z
        // A standing animal still finishes a turn it began: one that stopped mid-swing eases round rather than holding a half-turned pose.
        if (c.speed > 0) this._walk(c, step, probing)
        else this._turn(c, step)

        // On a probe frame the real ground; between them the plane that probe
        // measured, which is what makes a long stride cost nothing visible.
        if (probing) {
          c.y = this.walk.heightAt(c.x, c.z)
          this.walk.normalAt(c.x, c.z, undefined, _norm)
          c.nx = _norm.x; c.ny = _norm.y; c.nz = _norm.z
        } else {
          c.y -= (c.nx * (c.x - wasX) + c.nz * (c.z - wasZ)) / c.ny
        }

        // The card rung: one quad in the species' instanced buffer, and whatever
        // puppet it still has finishing its dissolve out against it.
        this._wantCard(c, tier === LOD_RUNGS)
        if (c.cardP < 1) c.cardP = Math.min(1, c.cardP + step / LOD_FADE_S)
        if (c.cardWant || c.cardP < 1) this._drawCard(c)
        if (tier === LOD_RUNGS) {
          if (!c.puppet) continue
          c.puppet.show(-1)
          c.puppet.step(dt)
          if (c.puppet.done) this._releasePuppet(c)
          continue
        }

        const puppet = this._takePuppet(c)
        if (!puppet) continue
        puppet.show(tier)
        _pos.set(c.x, c.y, c.z)
        // The body faces +X, yawed about the world up to its heading. It stands
        // on that up, never on the ground's normal, which is only the plane its
        // feet walk between probes: an animal on a hillside is vertical.
        _quat.setFromAxisAngle(UP, c.heading)
        _scl.setScalar(c.k)
        _mat.compose(_pos, _quat, _scl)

        puppet.play(c.clip, c.cue)
        groundFeet(puppet, c, this.walk, PLANTED, probing)
        puppet.step(dt)
        // Every frame, whether or not it re-posed: a held puppet slides on in the pose its bone texture holds (puppet.js POSE_EVERY).
        puppet.group.matrix.copy(_mat)
        puppet.group.matrixWorldNeedsUpdate = true
      }
    }

    // The cards of dropped kills finishing their dissolve where they were let go.
    for (let i = this.fadingCards.length - 1; i >= 0; i--) {
      const f = this.fadingCards[i]
      f.p = Math.min(1, f.p + dt / LOD_FADE_S)
      if (f.p < 1) { this._pushCard(f.sp, f.mat, -(1 - f.p)); continue }
      this.fadingCards[i] = this.fadingCards[this.fadingCards.length - 1]
      this.fadingCards.pop()
    }

    for (const sp of this.species) this._commitCards(sp)
  }

  dispose() {
    this.batch.parent?.remove(this.batch)
    for (const sp of this.species) {
      sp.plain.dispose()
      for (const mats of sp.materials) for (const m of [mats.in, mats.out]) m.dispose()
      sp.cardMaterial.map?.dispose()
      sp.cardMaterial.dispose()
      sp.cardMesh?.geometry.dispose()
      sp.asset?.map?.dispose()
      for (const geo of sp.asset?.tiers ?? []) geo.dispose()
    }
  }
}
