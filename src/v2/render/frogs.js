// ---------------------------------------------------------------------------
// Frogs: the bogpip, skinned and played from a baked texture (frog-anim.js), scattered on dry ground within a few metres of
// every riverbank and lake shore below the cold, sitting and hopping about.
//
// PLACEMENT IS A PURE FUNCTION OF POSITION. Each 8 m tile around her rolls its
// candidates from its own seed (critters.js tileSeed), so the same shore has the
// same frogs every visit and nothing is stored between visits. A candidate is a
// frog if the ground is dry, gentle, under the snow line by a margin, clear of
// stone (Rocks.blockTopAt) and within SHORE_M of a shore -- WaterSurfaces.
// shoreDistAt, which answers for lakes and rivers alike. DENSITY is per square
// metre of tile and is the brief's number; the shore band then keeps a small
// fraction of the candidates, which is the point of rolling everything and
// rejecting rather than sampling the band -- the band has no closed form.
//
// AND SO IS EVERYTHING A FROG DOES (_notes/creature-sync.md). A frog's life
// runs on the room's clock, cut into segments of GRID_S seconds on its own
// grid (sim/score.js), and every segment runs from one POST to the next: a
// seat within TETHER_M of home rolled from the frog's key and the segment's
// index, so any client, meeting the bed at any moment, plans the same segment
// and draws the frog in the same place. Between two posts the frog sits, then
// moves in a bout laid at plan time: usually a WALK, a string of short hops
// along the line between the posts with a beat between them, else a LEAP or
// a few, each landing swung off the line and every landing passing the tests
// its placement did but for dryness -- so a frog never hops up a rock, into
// the cold or off the band, which runs SHORE_M to either side of the
// waterline. A landing in the water floats there, sunk SINK of its height
// into the surface (WaterSurfaces.levelAt, bobbing on BOB_S) for a longer
// beat, and hops on; a post may be in the water too, within WADE_M of the
// bank, and the frog floats out its sits there. A bout no jitter can lay past a stone sits the segment
// out. A hop is a parabola between its two landings, so a frog's pose at any
// second is arithmetic on the plan: nothing is integrated, nothing depends on
// the frame, and a frog out of view costs one plan a segment. A frog sits on
// the DRAWN ground, and is put back on it whenever the terrain's render set
// changes under it (_reseat), so a chunk re-splitting at distance never
// buries it; a frog whose home turns out to be inside a boulder that landed
// after it leaves. The mesh faces +X; a hop plays the hop clip and turns it to face where it is
// going, and it sits with its up along the field's normal there (the world's
// up on the water), turning from the one slope to the other in the air.
//
// A LURE HAS IT. A spider, a butterfly or a grasshopper in a hand (hands.js
// lures, hers and the peers') within LURE_M of a frog takes it off its plan:
// it CHASEs, one hop at a time, each aimed at the lure and swung by up to
// CHASE.turn either way so the track is a scribble. Within ORBIT_M of a lure
// in a hand it STAYs, facing it, now and then hopping in place with a croak;
// within ORBIT_M of a hob on its feet it hops across it instead. Afloat, it hops for the
// lure off the water. It forgets the lure once the hand is empty or the lure
// is LURE_FORGET_M off, and REJOINS: a bout laid from where it is to the post
// of the next segment turn at least REJOIN_MIN_S off, and the plan has it
// again from that turn. The chase runs on every client off the relayed hand,
// so a peer's frog chases here too; the one thing sent is the bed's LURED
// SET (creature-net.js), which frogs of a bed her hand has, so a client
// hearing it keeps a frog the lure is between LURE_M and LURE_FORGET_M from,
// as she does.
//
// A HOB IS PREY. In a glade the hobs are lures too (hobs.js lures), chased
// the same way but on each client's own hobs, so never in a lured set; the
// hob runs from it (chasers()). A villager who sees it CATCHES the frog
// (villagers.js claims): it freezes where it was seen ('wait'), is posed in
// the villager's fist ('held') and is thrown as one hop into the water from
// the release second ('thrown'), then floats WET_PAUSE_S and rejoins; let go
// unthrown, it drops and rejoins. Either way it ignores hobs CALM_S after.
//
// SHE TAKES ONE (hands.js source 'frog'): a bed frog taken is in the taken
// registry and never regrows. Let go, it is LOOSE: off any bed, it lands, hops
// off from her and WANDERs on, chasing lures like any frog, until she is
// RADIUS off. One that EATS the bug in her hand (held within EAT of it) grows
// GROW and turns loose as her PET, following her (or the peer who fed it) to
// FOLLOW_M and no nearer; every bug after grows it MEAL.grow and makes it the
// pet of whoever fed it. The room hears a release as DROP, a feeding as FED
// and a loose frog taken as TOOK, each one anchor keyed by the loose frog.
//
// A HOP IS HEARD. The frame a frog starts a hop, and the frame one lands in
// the water off dry ground, it says so to the ear (voices(), ambience.js
// frogHop and splash); the queue is this frame's only, so nothing said while
// the ambience is not listening is heard late.
//
// A frog is drawn on the rung of its ladder its apparent size calls for
// (frogTier): the pick or LOD2, one InstancedMesh each under one material, or
// a bed frog's far card (an instance of the shared litter quad, written by the
// sweep), and not at all under the last rung.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { GRID_S, hash32, keyHash, phraseRand } from '../../sim/score.js'
import { DROP, dropWire, snap } from '../creature-net.js'
import { taken, TOLERANCE_M } from '../taken.js'
import {
  CRITTER_GLB, LOD_DEG, TIER_TINTS, critterLodUrl, distAt, glint, hueTurnTint, hueVary, ladderTier, loadCritterGlb, makeHueAttribute, setCritterAsset, tierTintOn, tileSeed, walkTiles,
} from './critters.js'
import { CARD_DRIFT_S, cardPicture } from './litter-cards.js'
import { PropArena } from './prop-arena.js'
import { getPropClock } from '../../material.js'
import { MEAL } from '../eating.js'
import { KEEP_UP, headway } from '../keep-up.js'
import { PhraseTable, ROW_W, motionSplice } from './gpu-motion.js'
import { FROG_ANIM_NORMAL, FROG_ANIM_PARS, FROG_ANIM_VERTEX, hopWeight, idleWeight, loadFrogAnim, writeAnim } from './frog-anim.js'

// Frogs per square metre, a quarter of the brief's figure (which crowded the banks); candidates per tile before the shore band rejects most of them.
export const DENSITY = 0.025
export const TILE = 8
// Tiles whose centre is within this of her are grown; the biggest frog is under the last rung past twenty metres.
export const RADIUS = 48
// The ladder (critters.js ladderTier): the mesh tiers, the pick and the shipped -lod2 (LOD_LEVELS), then the CARD rung; rung k reaches LOD_STEPS[k] times the world ladder's first. A 0.36 m frog steps down at 3.2 and 6.5 m and is gone past 12.9.
export const LOD_TIERS = 2
export const LOD_LEVELS = [0, 2]
export const LOD_STEPS = [2, 4, 8]
export const CARD = LOD_TIERS
export const RUNGS = LOD_TIERS + 1
/** The rung a frog of `size` at `dist` is drawn on, given the one it was on; RUNGS is not drawn. */
export const frogTier = (size, dist, prev) => ladderTier(distAt(size, LOD_DEG), LOD_STEPS, RUNGS, dist, prev)
// How far from the waterline a frog may sit, on the dry side.
export const SHORE_M = 5
// The ground a frog will not sit on: steeper than this (a tangent), or within SNOW_MARGIN metres of the snow line, which is the cold the brief excludes.
export const MAX_TAN = Math.tan((35 * Math.PI) / 180)
export const SNOW_MARGIN = 25
// Body length in metres, half to one and a half times the 0.36 m middle; and the pool: 200 slots is a shore's worth at the density and radius above, with room over.
export const SIZE_M = [0.18, 0.54]
export const MAX = 200
// A sitting frog breathes: its body swells by BREATH_AMP (more in height than in length) once every BREATH_S seconds, each frog on its own phase.
export const BREATH_S = 1.3
export const BREATH_AMP = 0.05
// Wet skin: the one roughness the whole frog glints at (critters.js's glint), set by eye -- a tighter lobe read as cling film, not skin.
export const WET_ROUGHNESS = 0.6
// A frog's colour morph, rolled by weight `w`: its hue, a turn of that many radians round the colour wheel (critters.js hueVary; negative turns the map's green toward orange), and its tint, a per-channel multiplier on the texture. Green frogs turn a little either way from the map, olive ones sit dark on it, and brown ones turn a quarter of the wheel and go dark and warm, which lands the map's green on a tawny brown.
export const MORPHS = [
  { name: 'green', w: 5, hue: [-0.5, 0.5], r: [0.7, 1.15], g: [0.8, 1.2], b: [0.6, 1.1] },
  { name: 'olive', w: 2, hue: [-0.3, 0.15], r: [0.55, 0.75], g: [0.6, 0.8], b: [0.35, 0.55] },
  { name: 'brown', w: 3, hue: [-1.1, -0.75], r: [0.75, 0.95], g: [0.6, 0.78], b: [0.4, 0.55] },
]
const MORPH_W = MORPHS.reduce((sum, m) => sum + m.w, 0)
// A segment: sit SIT_S at its first post, then the bout to its next, then sit out the rest. A bout is `hops` hops of `m` body lengths, each `dur` seconds long with a `pause` sit between, WALK_P of the time a walk when the posts are within HOPS_MAX walking hops of each other, else a leap; each landing but the last is swung off the line between the posts by the sine of up to `turn` radians of the hop's reach, so a walk holds its line and a leap scribbles. Every hop rises HOP_RISE of its distance. A bout longer than a segment is hurried to fit; one no jitter can lay is not made, and the frog sits the segment out (LAY_TRIES jitters, HOPS_MAX hops).
export const SIT_S = [1, 5]
const WALK_P = 0.7
export const WALK = { hops: [3, 8], m: [0.6, 1.2], dur: [0.18, 0.28], pause: [0.3, 1], turn: 0.3 }
export const LEAP = { hops: [1, 3], m: [3, 6], dur: [0.3, 0.45], pause: [0.15, 0.5], turn: Math.PI / 4 }
const HOP_RISE = 0.45
const LAY_TRIES = 3
export const HOPS_MAX = 12
// A post is rolled within TETHER_M of home, as often near it as far, POST_TRIES seats tried before it is home itself; one in the water within WADE_M of the bank will do, and the frog floats there.
export const TETHER_M = 4
const POST_TRIES = 4
export const WADE_M = 1.5
// A landing in the water floats there this long before the next hop.
export const WET_PAUSE_S = [1.5, 4]
// The lure: what a frog wants, in a hand or (the hob) on its own feet, how near (across the ground) it is noticed and how far it is kept, the bout it is chased with, within what of the lure a hop goes across it rather than at it, how soon a sitting frog reacts, and the least a rejoin is given to reach its post.
export const LURES = ['spider', 'butterfly', 'grasshopper', 'hob']
export const LURE_M = 3
export const LURE_FORGET_M = 8
export const CHASE = { hops: [1, 1], m: [1.5, 3], dur: [0.22, 0.34], pause: [0.1, 0.45], turn: 1.6 }
export const ORBIT_M = 0.7
// Staying at a lure in a hand: each sit `sit` s, then `bob` of the time a hop in place `rise` body lengths high, croaking.
export const STAY = { sit: [0.5, 1.6], bob: 0.35, dur: 0.3, rise: 0.8 }
// Her bug or hob (MEALS) is eaten by a frog it is within `m` of across the ground and `dy` above or below; the frog grows by GROW. A pet keeps FOLLOW_M off her, leaping (LEAP's reach) while she is past LURE_M.
export const EAT = { m: ORBIT_M, dy: 0.5 }
const MEALS = ['spider', 'butterfly', 'grasshopper', 'hob']
export const GROW = 1.1
export const FOLLOW_M = 1.2
// A frog let go hops this far on from her before it sits.
const AWAY_M = [1.5, 3]
// Loose with nothing to chase, it wanders: a WALK hop each sit, its heading swung up to `turn` off the last and bent `away` of the way to straight off the drop, a WALK beat between and `rest` of the time a SIT_S sit instead.
const WANDER = { turn: 1.2, away: 0.3, rest: 0.2 }
export const FED = 'fed'
export const TOOK = 'took'
/** A loose frog's key: where it was let go, to the centimetre, and the way from her it faced. */
export const dropKey = (x, z, yaw) => `fg@${x.toFixed(2)},${z.toFixed(2)},${Math.round(yaw * 1000)}`
export const NOTICE_S = 0.3
export const REJOIN_MIN_S = 2
const NO_LURES = []
// A bed's lured set goes to the room when the frogs her hand has change, at most once in LURED_EVERY_S.
export const LURED_EVERY_S = 1
// Caught: the hop to where it was seen, the throw's flight and its rise over the line, and how long after it hobs are let be.
const FREEZE_HOP_S = 0.3
export const THROW_S = 0.7
const THROW_RISE = 1
export const CALM_S = 30
const NO_CLAIMS = new Map()
// Afloat, a frog sits SINK of its height under the surface and rides it up and down by BOB_AMP metres once every BOB_S seconds, on its breath's phase.
export const SINK = 0.5
export const BOB_S = 0.5
export const BOB_AMP = 0.04
// The tiles are re-walked once her head has moved this far from where they were last walked: RADIUS is generous by more than this, and a walk is a Map of a hundred tiles read and as many looked up.
const WALK_M = 4
// A frog further than this from her head says nothing to the ear: the splash's reach (ambience.js RULES.splash), the farther of its two sounds.
const HEAR_M = 30
// A bed frog on its plan is posed in the vertex shader from its row of the phrase table (gpu-motion.js): phrase kinds are a dry sit, a sit afloat, a hop (to the next phrase's spot) and the CPU row, which hands back the instance matrix.
const SIT = 0
const SIT_WET = 1
const HOP = 2
const CPU = 3
// The drawn list is re-sorted into tiers when she has moved this far from where it was last sorted, or a frog has begun or ended a phrase and this long has passed.
export const SWEEP_M = 0.25
export const SWEEP_S = 0.25
// The most a frog strays from its home, on its plan: TETHER_M to a post, and a leap's swing off the line to the next.
const EXCURSION_M = TETHER_M + 4

// The body of gpuMotion (gpu-motion.js) for a frog. Phrase texels: A = start, dur, kind, a hop's rise; B = x, y, z, yaw of the sit or the hop's take-off; D = ground normal there. A hop runs to the NEXT phrase's B (landing spot and yaw) and D (landing normal): a segment always ends in a sit. uFrogPhase is the breath's and the surface bob's phase, a turn of 2 pi each, aBreath the frog's own offset, which also sets its place in the idle loop. Each branch sets `frogAnim` (frog-anim.js); the CPU row hands back the mesh's own matrix and aAnim.
const MOTION_GLSL = /* glsl */ `
  int p = phraseAt( row, n, e );
  vec4 A = texel( row, 1 + 4 * p );
  if ( A.z > 2.5 ) { frogAnim = aAnim; return instanceMatrix; }
  vec4 B = texel( row, 2 + 4 * p );
  vec3 pos = B.xyz;
  vec3 nrm = texel( row, 4 + 4 * p ).xyz;
  float yaw = B.w;
  vec3 sc = vec3( 1.0 );
  if ( A.z > 1.5 ) {
    vec4 T = texel( row, 6 + 4 * p );
    vec3 nTo = texel( row, 8 + 4 * p ).xyz;
    float u = A.y > 0.0 ? clamp( ( e - A.x ) / A.y, 0.0, 1.0 ) : 1.0;
    pos = mix( B.xyz, T.xyz, u );
    pos.y += 4.0 * A.w * u * ( 1.0 - u );
    float v = min( 1.0, u * 1.5 );
    nrm = mix( nrm, nTo, v );
    vec2 d = T.xz - B.xz;
    float bear = dot( d, d ) < 1e-18 ? T.w : atan( -d.y, d.x );
    yaw = bear + atan( sin( T.w - bear ), cos( T.w - bear ) ) * v;
    frogAnim = frogHop( u );
  } else {
    frogAnim = frogIdle( aBreath * ${(1 / (2 * Math.PI)).toFixed(7)}, e - A.x, A.y );
    if ( A.z > 0.5 ) {
      pos.y += ${BOB_AMP.toFixed(4)} * sin( uFrogPhase.y + aBreath );
    } else {
      float s = ${BREATH_AMP.toFixed(4)} * ( 0.5 + 0.5 * sin( uFrogPhase.x + aBreath ) );
      sc = vec3( 1.0 + s * 0.4, 1.0 + s, 1.0 + s * 0.4 );
    }
  }
  nrm = normalize( nrm );
  vec4 q = normalize( vec4( nrm.z, 0.0, -nrm.x, 1.0 + nrm.y ) );
  float xy = q.x * q.y, xz = q.x * q.z, yz = q.y * q.z, xw = q.x * q.w, yw = q.y * q.w, zw = q.z * q.w;
  float xx = q.x * q.x, yy = q.y * q.y, zz = q.z * q.z;
  mat3 tilt = mat3(
    1.0 - 2.0 * ( yy + zz ), 2.0 * ( xy + zw ), 2.0 * ( xz - yw ),
    2.0 * ( xy - zw ), 1.0 - 2.0 * ( xx + zz ), 2.0 * ( yz + xw ),
    2.0 * ( xz + yw ), 2.0 * ( yz - xw ), 1.0 - 2.0 * ( xx + yy ) );
  float cy = cos( yaw ), sy = sin( yaw );
  mat3 R = tilt * mat3( cy, 0.0, -sy, 0.0, 1.0, 0.0, sy, 0.0, cy );
  float k = head.z;
  return mat4( vec4( R[ 0 ] * ( k * sc.x ), 0.0 ), vec4( R[ 1 ] * ( k * sc.y ), 0.0 ), vec4( R[ 2 ] * ( k * sc.z ), 0.0 ), vec4( pos, 1.0 ) );
`

/** The room's key for a bed of frogs, its tile; a frog's is the bed's and its candidate index (creature-net.js routes the `fg` prefix here). */
export const bedKey = (tx, tz) => `fg:${tx},${tz}`
export const keyOf = (tx, tz, i) => `${bedKey(tx, tz)}:${i}`

const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()
/** The heading from `a` to `b`: a hop along it is x += cos, z -= sin. */
const bearing = (a, b) => Math.atan2(-(b.z - a.z), b.x - a.x)
const UP = new THREE.Vector3(0, 1, 0)
const _quat = new THREE.Quaternion()
const _tilt = new THREE.Quaternion()
const _nrm = new THREE.Vector3()
const _pos = new THREE.Vector3()
const _scl = new THREE.Vector3()
const _mat = new THREE.Matrix4()
const _stone = { x: 0, z: 0, r: 0 }
const _her = new THREE.Vector3()
const _tint = new THREE.Color()

/** A frog's slot. While the frog is drawn by the GPU (`gpu`) its x, y, z read the plan at the room's clock, so a reader between frames (sense.js, hands.js) sees where the shader draws it. */
class Frog {
  constructor(owner, init) {
    this.owner = owner
    Object.assign(this, init)
  }

  get x() { if (this.gpu && this.sat !== this.owner.now) this.owner._sync(this); return this._x }
  set x(v) { this._x = v }
  get y() { if (this.gpu && this.sat !== this.owner.now) this.owner._sync(this); return this._y }
  set y(v) { this._y = v }
  get z() { if (this.gpu && this.sat !== this.owner.now) this.owner._sync(this); return this._z }
  set z(v) { this._z = v }
}

export class Frogs {
  /**
   * @param height  V2Height: heightAt, heightAndSlopeAt, snowLineAt
   * @param water   WaterSurfaces: levelAt, shoreDistAt
   * @param opts.rocks   Rocks, for blockTopAt; a frog never sits on stone
   * @param opts.ground  TerrainV2 or null: the drawn surface to seat on, falling back to the field
   * @param opts.assets  parsed assets (critters.js shape, skinned) for a gate; the world fetches the GLBs
   * @param opts.anim    the parsed animation (frog-anim.js) that goes with `assets`
   * @param opts.cards   the shared LitterCards: the far bed frogs are its instances, one per slot
   * @param opts.eat     (lure) => true once her hand holding it has lost it (hands.js eatLure)
   */
  constructor(scene, height, water, { seed = 1, rocks, ground = null, assets = null, anim = null, cards = null, eat = () => false } = {}) {
    if (!cards || typeof cards.claim !== 'function') throw new Error('Frogs needs the LitterCards its far card is drawn by')
    if (!height || typeof height.heightAt !== 'function' || typeof height.heightAndSlopeAt !== 'function' || typeof height.snowLineAt !== 'function') {
      throw new Error('Frogs needs a height field with heightAt, heightAndSlopeAt and snowLineAt')
    }
    if (!water || typeof water.shoreDistAt !== 'function' || typeof water.levelAt !== 'function') {
      throw new Error('Frogs needs WaterSurfaces, for shoreDistAt and levelAt')
    }
    if (!rocks || typeof rocks.blockTopAt !== 'function') throw new Error('Frogs needs Rocks, for blockTopAt')
    if (ground && (typeof ground.groundAt !== 'function' || typeof ground.groundVersion !== 'number')) {
      throw new Error('Frogs: `ground` was given but has no groundAt and groundVersion -- pass the TerrainV2 or nothing')
    }
    this.height = height
    this.water = water
    this.rocks = rocks
    this.ground = ground
    this.gver = ground ? ground.groundVersion : 0
    this.seed = seed
    this.eat = eat

    // Wet skin glints: critters.js's glint. One material for every tier; the tiers share the pick's colour map.
    this.material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: WET_ROUGHNESS, metalness: 0 })
    // Table row of each instance: a frog's is its slot id + 1; row 0 is the CPU row, which the tail of a tier and a held copy (hands.js defaults every instanced attribute to 0) are drawn by.
    this.table = new PhraseTable(MAX + 1)
    this.table.write(0, 0, 1, [{ kind: CPU, start: 0, dur: 1, apex: 0, yaw: 0, a: { x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0 }, b: null }])
    this.uPhase = { value: new THREE.Vector2() }
    this.uClips = { value: new THREE.Vector4() }
    this.uIdle = { value: 0 }
    this.material.onBeforeCompile = (shader) => {
      if (this.anim === null) throw new Error('Frogs: drawn before its animation landed')
      shader.uniforms.uFrogPhase = this.uPhase
      shader.uniforms.uFrogAnim = { value: this.anim.texture }
      shader.uniforms.uFrogClips = this.uClips
      shader.uniforms.uFrogIdle = this.uIdle
      // Before the frog's own declarations, which must come ahead of the motion block.
      motionSplice(shader, this.table, MOTION_GLSL)
      for (const chunk of ['#include <common>', '#include <beginnormal_vertex>', '#include <begin_vertex>']) {
        if (!shader.vertexShader.includes(chunk)) throw new Error(`Frogs: the shader has no ${chunk}`)
      }
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${FROG_ANIM_PARS}\n#ifdef USE_INSTANCING\nuniform vec2 uFrogPhase;\nattribute float aBreath;\n#endif`)
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${FROG_ANIM_NORMAL}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${FROG_ANIM_VERTEX}`)
      glint(shader)
      hueVary(shader)
    }
    this.material.customProgramCacheKey = () => 'frogs'
    this.tinted = false
    this.tiers = Array.from({ length: LOD_TIERS }, (_, k) => {
      const mesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), this.material, MAX)
      mesh.name = k ? `v2-frogs-lod${LOD_LEVELS[k]}` : 'v2-frogs'
      mesh.count = 0
      // Hidden, not merely empty, until the asset lands: the boot's scene census throws on a visible mesh with no geometry.
      mesh.visible = false
      mesh.frustumCulled = false
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3).fill(1), 3)
      return mesh
    })
    this.hues = this.tiers.map((mesh) => makeHueAttribute(mesh, MAX))
    this.rowAttrs = this.tiers.map((mesh) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1)
      a.setUsage(THREE.DynamicDrawUsage)
      mesh.geometry.setAttribute('aRow', a)
      return a
    })
    this.breathAttrs = this.tiers.map((mesh) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1)
      a.setUsage(THREE.DynamicDrawUsage)
      mesh.geometry.setAttribute('aBreath', a)
      return a
    })
    // The pose of each CPU-drawn instance (frog-anim.js writeAnim); a GPU one builds its own.
    this.animAttrs = this.tiers.map((mesh) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4)
      a.setUsage(THREE.DynamicDrawUsage)
      mesh.geometry.setAttribute('aAnim', a)
      return a
    })
    this.anim = null
    // Per tier: the instances the GPU poses (the head of the tier's arrays) and the CPU-driven tail after them, and this frame's sweep tallies.
    this.gpuCounts = this.tiers.map(() => 0)
    this.tails = this.tiers.map(() => 0)
    this._counts = this.tiers.map(() => 0)
    this.mesh = this.tiers[0]
    this.hue = this.hues[0]
    // The layer toggle flips the group, so it cannot unhide a mesh before its geometry lands.
    this.batch = new THREE.Group()
    this.batch.name = 'v2-frogs'
    this.batch.add(...this.tiers)
    scene.add(this.batch)
    // The far bed frogs, one litter-card instance per slot (a slot's id is its card's), drawn once the picture is baked (bakeCard); until then the card rung draws LOD2. `carded` holds the slots with a card on.
    const cardBudget = cards.claim('frogs', MAX)
    this.litterCards = cards
    this.cardPicture = -1
    this.cardReady = false
    this.cardMean = null
    this.cards = PropArena.over(cards.meshes, MAX, 'v2-frogs-card', { budget: cardBudget })
    for (let i = 0; i < MAX; i++) {
      this.cards.addInstance(0)
      this.cards.setVisibleAt(i, false)
    }
    this.carded = new Set()
    this.sweepNo = 0

    this.slots = []
    for (let i = 0; i < MAX; i++) {
      this.slots.push(new Frog(this, {
        id: i, tile: null, key: '', index: 0, offset: 0,
        x: 0, y: 0, z: 0, homeX: 0, homeZ: 0, yaw: 0, size: 0.36, breath: 0, r: 1, g: 1, b: 1, hue: 0, lod: RUNGS,
        // Its far card: shown, the phrase it was written at, and the sweep that last kept it.
        cardOn: false, cardPh: null, cardStamp: -1,
        // The ground normal the frog sits along.
        nx: 0, ny: 1, nz: 0,
        // The phrase playing -- a 'sit' at a spot or a 'hop' between two -- `t` seconds into it, `wet` when the frog is afloat; `u` the hop's fraction flown.
        state: 'sit', ph: null, t: 0, u: 0, wet: false,
        // The planned segment (see _segment), and off the plan -- chasing a lure, or rejoining it -- the live phrase and when it began, its queue of laid phrases (a rejoin) and the turn the plan is back at.
        seg: null, live: null,
        // Its own noise for the chase, and the lure it is chasing (hands.js lures: kind, x, y, z, by), if any.
        rand: null, lured: false, lure: null,
        // A villager's hold on it (villagers.js claims) as last applied: null, 'wait', 'held' or 'thrown'; and the second it heeds hobs again.
        caught: null, calm: -Infinity,
        // A loose frog's pet bond: null, or `{ by, at }`, by null for her, else the peer who fed it last, on second `at`.
        pet: null,
        // A loose frog in the cave she is in (goUnder), sitting on its walk.
        under: false,
        // Who poses it: `gpu`, the shader from its row (x, y, z read the plan); `cpu`, this layer each frame (in `this.cpu`); neither, not yet planned. `rowSeg` the segment its row holds, `wake` the second its phrase or segment next turns, `sounded` the phrase _heard has accounted for, `sat` the clock x, y, z were last read at.
        gpu: false, cpu: false, rowSeg: null, wake: -Infinity, sounded: null, sat: -Infinity,
      }))
    }
    this.free = this.slots.slice()
    this.byKey = new Map()
    this.cpu = new Set()
    this.cpuTmp = []
    this.cpuAll = false
    this.oweTiles = new Set()
    this.nextWake = -Infinity
    this.listDirty = true
    this.hopped = false
    this.sweptAt = -Infinity
    this.sweptHead = { x: Infinity, y: Infinity, z: Infinity }
    this.tiles = new Map()
    this.head = { x: 0, z: 0 }
    this.now = 0
    // Where the tiles were last walked from.
    this.walkedX = Infinity
    this.walkedZ = Infinity
    // The pick's bounds (setCritterAsset) and its unit span; the instance scale is size / span, for every tier. `sink` is how far under the surface a floating frog's feet sit, per metre of its size.
    this.bounds = null
    this.span = 1
    this.sink = SINK
    this.loaded = false
    // Candidates the shore band would have kept that found no free slot.
    this.overflow = 0
    // Lured sets owed to the room (pendingLured), and the peers' by bed key (applyLured): { by, has }.
    this.owed = []
    this.luredIn = new Map()
    // The loose frogs (on no bed); the anchors owed the room (pending); the loose keys made or heard here, so a release is not made twice; and whether a peer's anchor is being applied, when nothing is owed back.
    this.loose = []
    this.outbox = []
    this.drops = new Set()
    this.applying = false
    // Her, as a pet follows her: her head across the ground.
    this.me = { kind: 'mate', x: 0, y: 0, z: 0, by: null }
    // Her, as her pets keep up with her (keep-up.js); null and one she leaves RADIUS behind is forgotten.
    this.her = null
    // The cave she is in ({ walk, apron }, goUnder), or null; and the cave walk the loose frog being stepped sits on, for seat, or null.
    this.cave = null
    this._in = null
    this.stats = { alive: 0, tiles: 0, overflow: 0, segments: 0 }
    // This frame's one-shots for the ear, drained by voices(): { sound, rule, x, y, z }.
    this.calls = []
    this.mates = []

    if (assets) {
      if (!anim) throw new Error('Frogs: an asset needs its anim')
      this.setAsset(assets, anim)
      this.ready = Promise.resolve(true)
    } else {
      this.ready = this.load()
    }
  }

  /** The pick, its ladder and the animation; the bake's bones are in the shipped frame, so the pick must need no move to sit centred on its feet. */
  async load() {
    const [pick, anim] = await Promise.all([loadCritterGlb(CRITTER_GLB.frog), loadFrogAnim()])
    if (pick.origin.some((v) => Math.abs(v) > 1e-3)) throw new Error(`Frogs: ${CRITTER_GLB.frog} is off its feet by ${pick.origin.join(', ')} -- rerun tools/creatures/ship-frog.mjs`)
    const tiers = await Promise.all(LOD_LEVELS.slice(1).map((level) => loadCritterGlb(critterLodUrl(CRITTER_GLB.frog, level), { origin: pick.origin })))
    this.setAsset([pick, ...tiers], anim)
    return true
  }

  /** One asset per tier, the pick first, each skinned to `anim`'s bones; a gate may pass fewer, and the last given stands in for the rest. */
  setAsset(assets, anim) {
    if (!Array.isArray(assets) || assets.length < 1 || assets.length > LOD_TIERS) throw new Error(`Frogs.setAsset: ${LOD_TIERS} tiers at most, the pick first`)
    this.anim = anim
    this.uClips.value.set(anim.idle.base, anim.idle.frames, anim.hop.base, anim.hop.frames)
    for (let k = 0; k < LOD_TIERS; k++) {
      const asset = assets[Math.min(k, assets.length - 1)]
      const n = asset.pos.length / 3
      if (asset.skinIndex?.length !== n * 4 || asset.skinWeight?.length !== n * 4) throw new Error(`Frogs: tier ${k} has no skin of ${n} vertices`)
      if (asset.skinIndex.some((b) => b < 0 || b >= anim.bones)) throw new Error(`Frogs: tier ${k} names a bone past the animation's ${anim.bones}`)
      if (k === 0) {
        this.bounds = setCritterAsset(this.tiers[0], this.material, asset, 'frogs')
        this.span = this.bounds.span
        this.sink = (SINK * this.bounds.height) / this.span
      } else {
        // Its own decode of the same WebP: the pick's is the one drawn.
        if (k < assets.length) asset.map?.dispose()
        setCritterAsset(this.tiers[k], this.material, { ...asset, map: null }, `frogs lod${LOD_LEVELS[k]}`)
      }
      this.tiers[k].geometry.setAttribute('skinIndex', new THREE.BufferAttribute(Float32Array.from(asset.skinIndex), 4))
      this.tiers[k].geometry.setAttribute('skinWeight', new THREE.BufferAttribute(Float32Array.from(asset.skinWeight), 4))
    }
    if (this.cardPicture < 0) {
      this.cardPicture = this.litterCards.addPicture(cardPicture('heading', this.bounds))
      for (let i = 0; i < MAX; i++) this.cards.setLayerShiftAt(i, this.cardPicture)
    }
    this.loaded = true
    this._relay()
  }

  /** Photograph the pick, sitting in its bind pose, onto the far card and start drawing the far bed frogs as cards. Once, after `ready`. Each card's hue turn is a tint on the picture's mean linear colour (critters.js hueTurnTint). */
  bakeCard(renderer) {
    if (!this.loaded) throw new Error('Frogs.bakeCard: the asset has not landed')
    this.litterCards.bake(renderer, this.cardPicture, this.mesh.geometry, this.material.map, this.bounds, 'heading')
    const px = this.litterCards.pixels(this.cardPicture)
    const mean = { r: 0, g: 0, b: 0 }
    let n = 0
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 128) continue
      _tint.setRGB(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255, THREE.SRGBColorSpace)
      mean.r += _tint.r; mean.g += _tint.g; mean.b += _tint.b
      n++
    }
    if (n === 0) throw new Error('Frogs.bakeCard: the card picture is empty')
    this.cardMean = { r: mean.r / n, g: mean.g / n, b: mean.b / n }
    this.cardReady = true
    this.listDirty = true
  }

  /** Draw the whole layer or none of it; the far cards are shared instances, so the batch's `visible` alone would leave them. */
  setShown(shown) {
    this.batch.visible = shown
    this.cards.setShown(shown)
  }

  /** Bed frog `f`'s far card, kept by this sweep: written when new, at a new phrase, and at every sweep of a hop, walking on a drift to its landing that reaches it by the hop's end or one drift, whichever is later, so it never overshoots before the next sweep. */
  _card(f) {
    f.cardStamp = this.sweepNo
    const hop = f.state === 'hop'
    if (f.cardOn && f.cardPh === f.ph && !hop) return
    f.cardPh = f.ph
    _quat.setFromAxisAngle(UP, f.yaw)
    _tilt.setFromUnitVectors(UP, _nrm.set(f.nx, f.ny, f.nz))
    _quat.premultiply(_tilt)
    _mat.compose(_pos.set(f._x, f._y, f._z), _quat, _scl.setScalar(f.size / this.span))
    this.cards.setMatrixAt(f.id, _mat)
    hueTurnTint(this.cardMean, f.hue, _tint)
    this.cards.setColorAt(f.id, _tint.setRGB(_tint.r * f.r, _tint.g * f.g, _tint.b * f.b))
    const s = hop ? Math.max((1 - f.u) * f.ph.dur, CARD_DRIFT_S) : 1
    const to = hop ? f.ph.to : { x: f._x, y: f._y, z: f._z }
    this.cards.setDriftAt(f.id, (to.x - f._x) / s, (to.y - f._y) / s, (to.z - f._z) / s, getPropClock())
    if (!f.cardOn) {
      this.cards.setVisibleAt(f.id, true)
      f.cardOn = true
      this.carded.add(f)
    }
  }

  _uncard(f) {
    this.cards.setVisibleAt(f.id, false)
    f.cardOn = false
    f.cardPh = null
    this.carded.delete(f)
  }

  /** Every bed frog's row is laid again at the next wake: its scale or its landings changed. */
  _relay() {
    for (const t of this.tiles.values()) for (const f of t.frogs) { f.rowSeg = null; f.wake = -Infinity }
    this.nextWake = -Infinity
  }

  _groundFor(x, z, fieldH) {
    if (this.ground && this._in === null) {
      const g = this.ground.groundAt(x, z)
      if (g !== null) return g
    }
    return fieldH
  }

  /**
   * Every landing put back on the drawn ground, which just changed shape: a
   * chunk re-splitting swaps the leaf's half-metre cells for metre ones 19 m
   * out (11 m in the periphery), and where the new chord rises through a seat
   * it buries the frog until its next hop. A frog afloat rides the water, not
   * the ground.
   */
  _reseat() {
    const spot = (s) => { if (s && !s.wet) s.y = this._groundFor(s.x, s.z, s.h) }
    this._relay()
    const phrase = (ph) => { if (ph.kind === 'sit') spot(ph.at); else { spot(ph.from); spot(ph.to) } }
    for (const t of this.tiles.values()) {
      for (const f of t.frogs) {
        if (f.seg) for (const ph of f.seg.phrases) phrase(ph)
        if (f.live) { phrase(f.live.ph); if (f.live.queue) for (const ph of f.live.queue) phrase(ph) }
      }
    }
  }

  /**
   * Whether a frog may sit at (x, z): warm, clear of stone, and either on the
   * water or on gentle dry ground, within SHORE_M of the waterline either way.
   * Returns the field's sample there -- height `h` and the gradient `gx`, `gz`
   * the frog sits across -- with `wet`, on the water the surface `level`, and
   * `shore`, how far from the waterline it is, negative on the water; or null.
   * A loose frog (`banks` false) may sit anywhere else as well, its `shore` NaN.
   */
  seat(x, z, banks = true) {
    if (this._in !== null) return this._caveSeat(x, z)
    const s = this.height.heightAndSlopeAt(x, z)
    const { h, tan } = s
    if (h > this.height.snowLineAt(x, z) - SNOW_MARGIN) return null
    if (this.rocks.blockTopAt(x, z, 0) > -Infinity) return null
    const level = this.water.levelAt(x, z)
    s.wet = level !== null && h < level
    s.level = s.wet ? level : null
    if (!s.wet && tan > MAX_TAN) return null
    if (!banks) { s.shore = NaN; return s }
    const shore = this.water.shoreDistAt(x, z, SHORE_M, h, tan)
    if (!(shore < SHORE_M && shore > -SHORE_M)) return null
    s.shore = shore
    return s
  }

  /** seat in the cave this._in about her feet, as a loose frog takes it: dry floor within a step up or a drop down, gentle and clear of stone. */
  _caveSeat(x, z) {
    const w = this._in, y0 = w.hintY
    const h = w.heightAt(x, z, y0)
    if (h > y0 + 0.6 || h < y0 - 1.5) return null
    const level = w.trueWaterAt(x, z, y0)
    if ((level !== null && level > h) || w.obstacleAt(x, z, _stone) !== null) return null
    const n = w.normalAt(x, z, undefined, undefined, y0)
    const gx = -n.x / n.y, gz = -n.z / n.y, tan = Math.hypot(gx, gz)
    if (tan > MAX_TAN) return null
    return { h, gx, gz, tan, wet: false, level: null, shore: NaN }
  }

  /**
   * Her loose pets near `apron` (the mouth's, { x, y, z }) set down inside
   * `door` ({ x, y, z, dx, dz }, world, facing in) to sit on `walk`
   * (caves/walk.js); the rest heed the apron as her while she is down.
   */
  goUnder(walk, apron, door) {
    this.cave = { walk, apron }
    this._in = walk
    let n = 0
    for (const f of this.loose) {
      if (f.pet === null || f.pet.by !== null || this.her === null || Math.hypot(f.x - apron.x, f.z - apron.z) > KEEP_UP.m) continue
      const side = (n % 2 ? -0.5 : 0.5) * Math.ceil((n + 1) / 2)
      this._setDown(f, door.x + door.dx - door.dz * side, door.z + door.dz + door.dx * side, Math.atan2(-door.dz, door.dx))
      f.under = true
      n++
    }
    this._in = null
  }

  /** She surfaces at `at` ({ x, y, z }) facing (fx, fz): her pets under with her set down behind her. */
  goUp(at, fx, fz) {
    let n = 0
    for (const f of this.loose) {
      if (!f.under) continue
      const side = (n % 2 ? -0.5 : 0.5) * Math.ceil((n + 1) / 2)
      f.under = false
      this._setDown(f, at.x - fx - fz * side, at.z - fz + fx * side, Math.atan2(-fz, fx))
      n++
    }
    this.cave = null
  }

  /** Loose frog `f` sat down at (x, z) facing `yaw`, on its seat there or, with none, the bare ground (this._in's while it is set). */
  _setDown(f, x, z, yaw) {
    const s = this.seat(x, z, false)
    f.live = { ph: { kind: 'sit', dur: 0, at: s === null ? this._groundSpot(f, x, z, yaw) : this._spot(f, x, z, s, yaw) }, at: this.now, queue: null, until: Infinity }
    f.way = headway()
    this._pose(f, f.live.ph, 0)
  }

  /** A spot frog `f` can sit at: the seat `s` at (x, z) as a landing, on the drawn ground or sunk into the water, with the normal it sits along (the world's up on the water) and the way it faces. */
  _spot(f, x, z, s, yaw = 0) {
    const len = s.wet ? 1 : Math.hypot(s.gx, 1, s.gz)
    return {
      x, z, h: s.h, wet: s.wet, level: s.level,
      y: s.wet ? s.level - f.size * this.sink : this._groundFor(x, z, s.h),
      nx: s.wet ? 0 : -s.gx / len, ny: 1 / len, nz: s.wet ? 0 : -s.gz / len,
      yaw,
    }
  }

  _enter(tx, tz) {
    const rand = mulberry32(tileSeed(tx, tz, this.seed))
    const t = { tx, tz, key: bedKey(tx, tz), frogs: [], luredSent: '', luredAt: -Infinity }
    const want = DENSITY * TILE * TILE
    const n = Math.floor(want) + (rand() < want % 1 ? 1 : 0)
    for (let i = 0; i < n; i++) {
      const x = (tx + rand()) * TILE
      const z = (tz + rand()) * TILE
      const size = between(rand, SIZE_M)
      let roll = rand() * MORPH_W
      const morph = MORPHS.find((m) => (roll -= m.w) < 0) ?? MORPHS[MORPHS.length - 1]
      const r = between(rand, morph.r)
      const g = between(rand, morph.g)
      const b = between(rand, morph.b)
      const hue = between(rand, morph.hue)
      const breath = rand() * Math.PI * 2
      // Placed on dry ground only; the water is reached by hopping in.
      const s = this.seat(x, z)
      if (s === null || s.wet || taken.has('frog', x, z)) continue
      const f = this.free.pop()
      if (!f) { this.overflow++; continue }
      f.tile = t
      f.key = keyOf(tx, tz, i)
      f.index = i
      f.offset = keyHash(f.key) % GRID_S
      f.x = f.homeX = x
      f.z = f.homeZ = z
      f.size = size
      f.y = this._groundFor(x, z, s.h)
      const home = this._spot(f, x, z, s)
      f.nx = home.nx; f.ny = home.ny; f.nz = home.nz
      f.r = r; f.g = g; f.b = b
      f.hue = hue
      f.yaw = 0
      f.breath = breath
      f.lod = RUNGS
      f.state = 'sit'
      f.ph = null
      f.wet = false
      f.seg = null
      f.live = null
      f.rand = mulberry32(hash32(keyHash(f.key), 0x1e))
      f.lured = false
      f.lure = null
      f.caught = null
      f.calm = -Infinity
      f.pet = null
      f.gpu = f.cpu = false
      f.rowSeg = null
      f.wake = -Infinity
      f.sounded = null
      f.sat = -Infinity
      this.byKey.set(f.key, f)
      this.nextWake = -Infinity
      t.frogs.push(f)
    }
    return t
  }

  /** Frog `f` out of the pool's bookkeeping for the GPU and the CPU lists; the drawn list is re-sorted. */
  _unlist(f) {
    if (f.gpu || f.cpu) this.listDirty = true
    f.gpu = f.cpu = false
    this.cpu.delete(f)
    this.byKey.delete(f.key)
  }

  _leave(t) {
    // A bed her hand had frogs of: the room hears they are let go.
    if (t.luredSent !== '') this.owed.push([t.key, 'fg', null, []])
    this.luredIn.delete(t.key)
    this.oweTiles.delete(t)
    for (const f of t.frogs) {
      this._unlist(f)
      f.tile = null
      this.free.push(f)
    }
    t.frogs.length = 0
  }

  _drop(f) {
    this._unlist(f)
    this.oweTiles.add(f.tile)
    const list = f.tile.frogs
    list.splice(list.indexOf(f), 1)
    f.tile = null
    this.free.push(f)
  }

  /** Rebuild every tile around (cx, cz). Boot, and whenever the ground moves under her. */
  place(cx, cz) {
    for (const t of this.tiles.values()) this._leave(t)
    this.tiles.clear()
    for (const f of this.loose) this.free.push(f)
    this.loose.length = 0
    this.listDirty = true
    this.overflow = 0
    this.head.x = cx
    this.head.z = cz
    walkTiles(this.tiles, cx, cz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t))
    this.walkedX = cx
    this.walkedZ = cz
  }

  // --- the plan ---------------------------------------------------------------

  /**
   * Where frog `f` sits at the turn of its segment `g`: a seat within TETHER_M
   * of home rolled from its key and `g`, its distance uniform so the posts
   * crowd home, dry or afloat within WADE_M of the bank, home itself when
   * POST_TRIES find none; null once home is stone. A pure function, so every
   * client has it.
   */
  _post(f, g) {
    const rand = phraseRand(f.key, g, 0)
    for (let k = 0; k < POST_TRIES; k++) {
      const a = rand() * Math.PI * 2
      const r = rand() * TETHER_M
      const x = f.homeX + Math.cos(a) * r
      const z = f.homeZ - Math.sin(a) * r
      const s = this.seat(x, z)
      if (s !== null && (!s.wet || s.shore > -WADE_M)) return this._spot(f, x, z, s)
    }
    const s = this.seat(f.homeX, f.homeZ)
    return s === null || s.wet ? null : this._spot(f, f.homeX, f.homeZ, s)
  }

  /** `spot` turned to face the way in from `prev`, and returned. */
  static _facing(prev, spot) {
    if (spot !== null && prev !== null) spot.yaw = Math.hypot(spot.x - prev.x, spot.z - prev.z) < 1e-9 ? prev.yaw : bearing(prev, spot)
    return spot
  }

  /**
   * The hops of a bout from spot `a` to spot `b` for frog `f`, with the beat
   * after each but the last, as `[hop, sit, hop, sit, ..., hop]` phrases; the
   * bout hurried to fit `budget` seconds. Null when no jitter lays every
   * landing on a seat, or nothing when the spots are one. `rand` is the
   * plan's or the frog's own.
   */
  _lay(f, rand, a, b, budget) {
    const D = Math.hypot(b.x - a.x, b.z - a.z)
    if (D < 1e-9) return []
    const bout = D <= WALK.m[1] * HOPS_MAX * f.size && rand() < WALK_P ? WALK : LEAP
    const n = Math.min(HOPS_MAX, Math.max(bout.hops[0], Math.ceil(D / (between(rand, bout.m) * f.size))))
    const reach = D / n
    const ax = (b.x - a.x) / D, az = (b.z - a.z) / D
    for (let attempt = 0; attempt < LAY_TRIES; attempt++) {
      const out = []
      let prev = a
      let laid = true
      for (let k = 1; k <= n; k++) {
        let spot = b
        if (k < n) {
          const side = Math.sin((rand() * 2 - 1) * bout.turn) * reach
          const x = a.x + ax * reach * k - az * side
          const z = a.z + az * reach * k + ax * side
          const s = this.seat(x, z, f.tile !== null)
          if (s === null) { laid = false; break }
          spot = this._spot(f, x, z, s)
          spot.yaw = bearing(prev, spot)
        }
        out.push({ kind: 'hop', dur: between(rand, bout.dur), from: prev, to: spot, rise: Math.hypot(spot.x - prev.x, spot.z - prev.z) * HOP_RISE, bout })
        if (k < n) out.push({ kind: 'sit', dur: between(rand, spot.wet ? WET_PAUSE_S : bout.pause), at: spot })
        prev = spot
      }
      if (!laid) continue
      const total = out.reduce((sum, ph) => sum + ph.dur, 0)
      if (total > budget) for (const ph of out) ph.dur *= budget / total
      return out
    }
    return null
  }

  /** The phrases' start offsets, and the list returned. */
  static _starts(phrases) {
    let t = 0
    for (const ph of phrases) { ph.start = t; t += ph.dur }
    return phrases
  }

  /**
   * Segment `g` of frog `f`: from its post at the turn to its post at the
   * next, `{ g, start, a, b, phrases }`, the phrases a sit of SIT_S at `a`,
   * the bout laid between (_lay) and the sit that fills the segment at `b`,
   * each stamped with its start offset; a bout that cannot be laid is a sit
   * of the whole segment at `a`, and the turn puts the frog at `b`. Null once
   * home is stone. Rolled from the key and `g` alone, so the same on every
   * client.
   */
  _segment(f, g) {
    const a = f.seg !== null && f.seg.g === g - 1 ? f.seg.b : Frogs._facing(this._post(f, g - 1), this._post(f, g))
    const b = Frogs._facing(a, this._post(f, g + 1))
    if (a === null || b === null) return null
    const rand = phraseRand(f.key, g, 1)
    const hops = this._lay(f, rand, a, b, GRID_S - SIT_S[0])
    let phrases
    if (hops === null) {
      phrases = [{ kind: 'sit', dur: GRID_S, at: a }]
    } else {
      const bout = hops.reduce((sum, ph) => sum + ph.dur, 0)
      const sit = Math.min(between(rand, SIT_S), GRID_S - bout)
      phrases = [{ kind: 'sit', dur: sit, at: a }, ...hops, { kind: 'sit', dur: GRID_S - sit - bout, at: b }]
    }
    this.stats.segments++
    return { g, start: g * GRID_S + f.offset, a, b, phrases: Frogs._starts(phrases) }
  }

  /** The phrase of `phrases` playing `e` seconds in, the last one past the end. */
  static _phraseAt(phrases, e) {
    let i = phrases.length - 1
    while (i > 0 && phrases[i].start > e) i--
    return phrases[i]
  }

  /** Frog `f` posed `e` seconds into phrase `ph`: sitting at its spot, or on the parabola between a hop's two, turning from the one slope and heading to the other in the air. */
  _pose(f, ph, e) {
    f.ph = ph
    f.t = e
    if (ph.kind === 'sit') {
      const s = ph.at
      f.state = 'sit'
      f.x = s.x; f.y = s.y; f.z = s.z
      f.yaw = s.yaw
      f.nx = s.nx; f.ny = s.ny; f.nz = s.nz
      f.wet = s.wet
      f.u = 0
      return
    }
    const { from, to } = ph
    const u = Math.min(1, e / ph.dur)
    f.state = 'hop'
    f.u = u
    f.wet = false
    f.x = from.x + (to.x - from.x) * u
    f.z = from.z + (to.z - from.z) * u
    f.y = from.y + (to.y - from.y) * u + 4 * ph.rise * u * (1 - u)
    // Turning from the slope it left to the one it lands on, ready before touchdown; and from the hop's bearing to the way it lands facing.
    const v = Math.min(1, u * 1.5)
    _nrm.set(from.nx + (to.nx - from.nx) * v, from.ny + (to.ny - from.ny) * v, from.nz + (to.nz - from.nz) * v).normalize()
    f.nx = _nrm.x; f.ny = _nrm.y; f.nz = _nrm.z
    const head = Math.hypot(to.x - from.x, to.z - from.z) < 1e-9 ? to.yaw : bearing(from, to)
    f.yaw = head + Math.atan2(Math.sin(to.yaw - head), Math.cos(to.yaw - head)) * v
  }

  // --- the lure ---------------------------------------------------------------

  /**
   * The lure this frog is on this frame: the nearest of `lures` (hands.js
   * lures) it wants, noticed within LURE_M across the ground and kept to
   * LURE_FORGET_M -- or, for a peer's lure whose bed's lured set names this
   * frog, kept from LURE_M on. A pet with none is on the one it follows
   * (`mates`: her, then the peers' heads). Noticing one takes the frog off its
   * plan; losing one starts its rejoin.
   */
  _notice(f, lures, now, mates) {
    let lure = null
    let best = Infinity
    for (const l of lures) {
      if (!LURES.includes(l.kind) || (l.by === 'hob' && now < f.calm)) continue
      const d = Math.hypot(l.x - f.x, l.z - f.z)
      if (d < best) { best = d; lure = l }
    }
    if (lure !== null) {
      const set = lure.by !== null && f.tile !== null ? this.luredIn.get(f.tile.key) : undefined
      const kept = (f.lured && f.lure.kind !== 'mate') || (set !== undefined && set.by === lure.by && set.has.has(f.index))
      if (best > (kept ? LURE_FORGET_M : LURE_M)) lure = null
    }
    if (lure === null && f.pet !== null) lure = mates.find((m) => m.by === f.pet.by) ?? null
    if (lure !== null) {
      f.lure = lure
      if (!f.lured) { f.lured = true; this._startChase(f, now) }
      return
    }
    if (!f.lured) return
    f.lured = false
    f.lure = null
    this._startRejoin(f, now)
  }

  /** Off the plan: the phrase playing goes on as the first live one, a sit cut to NOTICE_S at most, and the chase follows it. */
  _startChase(f, now) {
    if (f.live !== null) {
      const L = f.live
      if (L.ph.kind === 'sit') L.ph = { kind: 'sit', dur: Math.min(L.ph.dur, now - L.at + NOTICE_S), at: L.ph.at }
      L.queue = null
      L.until = Infinity
      return
    }
    const ph = f.ph
    const at = now - f.t
    const live = ph.kind === 'sit' ? { kind: 'sit', dur: Math.min(ph.dur, f.t + NOTICE_S), at: ph.at } : ph
    f.live = { ph: live, at, queue: null, until: Infinity }
  }

  /** The chase's next phrase after `prev`: after a hop the beat, after a sit a hop at the lure -- swung by up to CHASE.turn and landing on a seat, dry or wet; none of three found, the beat again. Within ORBIT_M of a hand's lure it stays (STAY), within ORBIT_M of a hob on its feet it hops a quarter turn across it. */
  _chaseNext(f, prev) {
    const spot = prev.kind === 'sit' ? prev.at : prev.to
    const l = f.lure
    const gap = Math.hypot(l.x - spot.x, l.z - spot.z)
    if (l.kind === 'mate' && gap < FOLLOW_M) return { kind: 'sit', dur: between(f.rand, STAY.sit), at: spot }
    const near = gap < ORBIT_M
    if (near && l.by !== 'hob') {
      if (prev.kind === 'hop' || spot.wet || f.rand() >= STAY.bob) return { kind: 'sit', dur: between(f.rand, STAY.sit), at: spot }
      const to = { ...spot, yaw: bearing(spot, l) }
      return { kind: 'hop', dur: STAY.dur, from: spot, to, rise: STAY.rise * f.size, bout: CHASE, croak: true }
    }
    if (prev.kind === 'hop') return { kind: 'sit', dur: between(f.rand, CHASE.pause), at: spot }
    let heading = bearing(spot, l)
    if (near) heading += (f.rand() < 0.5 ? 1 : -1) * (Math.PI / 2)
    let reach = between(f.rand, l.kind === 'mate' && gap > LURE_M ? LEAP.m : CHASE.m) * f.size
    // After her, a leap and its beat cover as much ground as she does.
    if (l === this.me && gap > LURE_M && this.her !== null) reach = Math.max(reach, this.her.pace(0) * (CHASE.dur[0] + CHASE.dur[1] + CHASE.pause[0] + CHASE.pause[1]) / 2)
    for (let attempt = 0; attempt < 3; attempt++) {
      const a = heading + (f.rand() - 0.5) * CHASE.turn
      const x = spot.x + Math.cos(a) * reach
      const z = spot.z - Math.sin(a) * reach
      const s = this.seat(x, z, f.tile !== null)
      if (s === null) {
        // Blocked that way: swing a quarter to three-quarters of a turn and try again.
        heading += (f.rand() < 0.5 ? 1 : -1) * (Math.PI / 4 + f.rand() * Math.PI / 2)
        continue
      }
      const to = this._spot(f, x, z, s, a)
      return { kind: 'hop', dur: between(f.rand, CHASE.dur), from: spot, to, rise: reach * HOP_RISE, bout: CHASE }
    }
    return { kind: 'sit', dur: between(f.rand, CHASE.pause), at: spot }
  }

  /** A loose frog's next phrase after `prev` with nothing to chase (WANDER): after a hop a beat, after a sit a hop on, swung off where blocked as the chase is; none of three found, the beat again. */
  _wanderNext(f, prev) {
    const spot = prev.kind === 'sit' ? prev.at : prev.to
    if (prev.kind === 'hop') return { kind: 'sit', dur: between(f.rand, spot.wet ? WET_PAUSE_S : f.rand() < WANDER.rest ? SIT_S : WALK.pause), at: spot }
    const off = bearing({ x: f.homeX, z: f.homeZ }, spot)
    let heading = spot.yaw + (f.rand() * 2 - 1) * WANDER.turn
    heading += Math.atan2(Math.sin(off - heading), Math.cos(off - heading)) * WANDER.away
    const reach = between(f.rand, WALK.m) * f.size
    for (let attempt = 0; attempt < 3; attempt++) {
      const x = spot.x + Math.cos(heading) * reach
      const z = spot.z - Math.sin(heading) * reach
      const s = this.seat(x, z, false)
      if (s !== null) return { kind: 'hop', dur: between(f.rand, WALK.dur), from: spot, to: this._spot(f, x, z, s, heading), rise: reach * HOP_RISE, bout: WALK }
      heading += (f.rand() < 0.5 ? 1 : -1) * (Math.PI / 4 + f.rand() * Math.PI / 2)
    }
    return { kind: 'sit', dur: between(f.rand, WALK.pause), at: spot }
  }

  /**
   * The lure lost: the phrase playing finishes (a sit ends now), and from
   * where it ends a bout is laid to the post of the first segment turn at
   * least REJOIN_MIN_S past that, the frog sitting there until the turn puts
   * it on its plan. No bout to be laid, it sits where it is until the turn.
   * A loose frog has no plan, and wanders on from where it ends.
   */
  _startRejoin(f, now) {
    const L = f.live
    if (L.ph.kind === 'sit') L.ph = { kind: 'sit', dur: now - L.at, at: L.ph.at }
    const end = L.ph.kind === 'sit' ? L.ph.at : L.ph.to
    if (f.tile === null) Object.assign(L, { queue: [], until: Infinity })
    else Object.assign(L, this._rejoin(f, end, L.at + L.ph.dur))
  }

  /** The rejoin from spot `from` at second `end`: `{ queue, until }`, the bout to the post of the first turn REJOIN_MIN_S past it and the sit there to the turn. */
  _rejoin(f, from, end) {
    const g = Math.floor((end + REJOIN_MIN_S - f.offset) / GRID_S) + 1
    const turn = g * GRID_S + f.offset
    const post = Frogs._facing(this._post(f, g - 1), this._post(f, g))
    const hops = post === null ? null : this._lay(f, f.rand, from, post, turn - end)
    if (hops === null) return { queue: [{ kind: 'sit', dur: turn - end, at: from }], until: turn }
    const bout = hops.reduce((sum, ph) => sum + ph.dur, 0)
    return { queue: [...hops, { kind: 'sit', dur: turn - end - bout, at: post }], until: turn }
  }

  /** One frame off the plan: the live phrase advanced to `now`, the chase (or a loose frog's wander) choosing each next phrase as the last ends and a rejoin playing its queue out; false once a bed frog's queue is spent, the plan's again. */
  _live(f, now) {
    const L = f.live
    while (now >= L.at + L.ph.dur) {
      if (L.queue !== null && (L.queue.length === 0 || now >= L.until)) {
        if (f.tile !== null) { f.live = null; return false }
        L.queue = null
      }
      L.at += L.ph.dur
      L.ph = L.queue !== null ? L.queue.shift() : f.lure !== null ? this._chaseNext(f, L.ph) : this._wanderNext(f, L.ph)
    }
    this._pose(f, L.ph, now - L.at)
    return true
  }

  // --- caught -----------------------------------------------------------------

  /** Frogs chasing a hob on dry ground, uncaught, for the villagers to see and the hobs to run from: `{ key, tx, tz, index, x, y, z, hob }` onto `into`. */
  chasers(into) {
    for (const t of this.tiles.values()) {
      for (const f of t.frogs) if (f.lured && f.lure.by === 'hob' && f.caught === null && !f.wet) into.push({ key: f.key, tx: t.tx, tz: t.tz, index: f.index, x: f.x, y: f.y, z: f.z, hob: f.lure.id })
    }
    return into
  }

  /** A spot on the ground under (x, z), not seated: where a frog let go in the air lands. */
  _groundSpot(f, x, z, yaw) {
    const h = this._in !== null ? this._in.heightAt(x, z) : this.height.heightAt(x, z)
    return { x, z, h, y: this._groundFor(x, z, h), wet: false, level: null, nx: 0, ny: 1, nz: 0, yaw }
  }

  /** The villager's hold `cl` on frog `f` this frame (undefined: none), after its plan has posed it: taken off the plan to sit where it was seen, posed in the fist, thrown, or let go. */
  _caught(f, cl, now) {
    if (cl === undefined) {
      if (f.caught === 'wait') this._startRejoin(f, now)
      else if (f.caught === 'held') {
        const from = this._groundSpot(f, f.x, f.z, f.yaw)
        const r = this._rejoin(f, from, now + FREEZE_HOP_S)
        f.live = { ph: { kind: 'hop', dur: FREEZE_HOP_S, from: { ...from, y: f.y }, to: from, rise: 0, bout: CHASE }, at: now, queue: r.queue, until: r.until }
      }
      f.caught = null
      f.calm = now + CALM_S
      return
    }
    if (cl.phase === 'wait' && f.caught === null) {
      f.lured = false
      f.lure = null
      const here = f.ph.kind === 'sit' ? f.ph.at : f.ph.to
      const s = this.seat(cl.x, cl.z)
      const spot = s === null || s.wet ? here : this._spot(f, cl.x, cl.z, s, Math.hypot(cl.x - here.x, cl.z - here.z) < 1e-3 ? here.yaw : bearing(here, cl))
      const stay = { kind: 'sit', dur: Infinity, at: spot }
      const ph = f.ph.kind === 'sit' ? { kind: 'sit', dur: f.t, at: here } : f.ph
      const queue = spot === here ? [stay] : [{ kind: 'hop', dur: FREEZE_HOP_S, from: here, to: spot, rise: Math.hypot(spot.x - here.x, spot.z - here.z) * HOP_RISE, bout: CHASE }, stay]
      f.live = { ph, at: now - f.t, queue, until: Infinity }
    } else if (cl.phase === 'held') {
      // Dangling from the fist by its back, nose up and belly out.
      f.state = 'held'
      f.x = cl.x; f.y = cl.y - f.size * 0.6; f.z = cl.z
      f.yaw = cl.heading
      _nrm.set(-Math.cos(cl.heading), 0.45, Math.sin(cl.heading)).normalize()
      f.nx = _nrm.x; f.ny = _nrm.y; f.nz = _nrm.z
      f.u = 0.5
      f.wet = false
    } else if (cl.phase === 'thrown' && f.caught !== 'thrown') {
      this._throw(f, cl, now)
    }
    f.caught = cl.phase
  }

  /** Out of the fist at `cl.from` on the release second, one hop onto the water toward `cl.to` (nearer where that is not water), a float, and the rejoin. */
  _throw(f, cl, now) {
    const t0 = Math.min(cl.t0, now)
    const from = { x: cl.from.x, y: cl.from.y, z: cl.from.z, h: cl.from.y, wet: false, level: null, nx: 0, ny: 1, nz: 0, yaw: cl.heading }
    let to = null
    for (const k of [1, 0.8, 0.6, 0.4]) {
      const x = from.x + (cl.to.x - from.x) * k, z = from.z + (cl.to.z - from.z) * k
      const s = this.seat(x, z)
      if (s !== null && s.wet) { to = this._spot(f, x, z, s, cl.heading); break }
    }
    to ??= this._groundSpot(f, cl.to.x, cl.to.z, cl.heading)
    const float = { kind: 'sit', dur: between(f.rand, WET_PAUSE_S), at: to }
    const r = this._rejoin(f, to, t0 + THROW_S + float.dur)
    f.live = { ph: { kind: 'hop', dur: THROW_S, from, to, rise: THROW_RISE, bout: LEAP }, at: t0, queue: [float, ...r.queue], until: r.until }
    this._live(f, now)
  }

  // --- her hands --------------------------------------------------------------

  /** The drawn frog nearest a hand at (x, y, z) whose body, a ball of its size, is within `reach`, and smaller than `maxSize`: `{ dist, f, size }` for take(), or null. Not one a villager has. For hands.js. */
  pickAt(x, y, z, reach, maxSize) {
    if (!this.batch.visible) return null
    let best = null
    let bestD = reach
    const consider = (f) => {
      if (f.size >= maxSize || f.lod === RUNGS || f.caught !== null) return
      const d = Math.hypot(f.x - x, f.y - y, f.z - z) - f.size * 0.5
      if (d < bestD) { bestD = d; best = { dist: Math.max(0, d), f, size: f.size } }
    }
    for (const t of this.tiles.values()) for (const f of t.frogs) consider(f)
    for (const f of this.loose) consider(f)
    return best
  }

  /** The frog of a pickAt() hit into her hand: a bed's put in the taken registry, a loose one's going told to the room. The record for hands.js; only one under `stowMax` m stows. */
  take(hit, stowMax) {
    const f = hit.f
    const k = f.size / this.span
    const rec = { kind: 'frog', name: 'frog', size: f.size, geometry: this.mesh.geometry, material: this.material, attrs: { aAnim: [0, 0, 0, 0], aHue: [f.hue] }, color: [f.r, f.g, f.b], scale: [k, k, k], stowable: f.size < stowMax }
    if (f.tile !== null) {
      taken.add('frog', f.homeX, f.homeZ)
      this._drop(f)
    } else {
      this._tell(f, TOOK, this.now, null)
      this._unloose(f)
    }
    return rec
  }

  /** A peer took the bed frog whose home is (x, z): taken here too, drawn or not. True when a resident bed has it. For hands-net.js. */
  evict(key, x, z) {
    if (key !== 'frog') return false
    const f = this._bedFrog(x, z)
    if (f === null) return false
    this.take({ dist: 0, f, size: f.size }, Infinity)
    return true
  }

  /** The geometry and material a packed frog is drawn with, or null until the asset lands. For hands.js. */
  dress(slot) {
    if (slot.kind !== 'frog') throw new Error(`Frogs.dress: not a frog, ${slot.kind}`)
    if (!this.loaded) return null
    return { geometry: this.mesh.geometry, material: this.material }
  }

  /**
   * Let a taken frog go at (x, y, z), `head` her head: it drops to the ground
   * under it and hops on AWAY_M from her, loose. Its key is the drop to the
   * centimetre and the way from her, its noise rolled from that, so every
   * client told of the release watches the one frog. False only when the pool
   * is empty, and hands.js drops it as a thing.
   */
  release(rec, x, y, z, head, now = this.now) {
    if (rec.kind !== 'frog') throw new Error(`Frogs.release: not a frog, ${rec.kind}`)
    x = snap(x); y = snap(y); z = snap(z); now = snap(now)
    const yaw = snap(bearing({ x: snap(head.x), z: snap(head.z) }, { x, z }))
    // Dressed as the anchor will carry it, so the frog a peer lets go is this one to the bit.
    const f = this._loosen({ x, z, yaw }, { size: snap(rec.size), hue: snap(rec.attrs.aHue[0]), color: rec.color.map(snap) }, { x, y, z, yaw }, now, true)
    if (f === null) return false
    this._tell(f, DROP, now, null, { x, y, z, yaw })
    return true
  }

  /** The bed frog whose home is (x, z), or null. */
  _bedFrog(x, z) {
    for (const t of this.tiles.values()) {
      for (const f of t.frogs) if (Math.abs(f.homeX - x) < TOLERANCE_M && Math.abs(f.homeZ - z) < TOLERANCE_M) return f
    }
    return null
  }

  /**
   * A loose frog keyed by `drop`, dressed as `look`, let go at `from` on second
   * `now`: it falls to the ground under it, and, `away`, hops on AWAY_M from
   * where it faced, and wanders on from there. Null when the pool is empty.
   */
  _loosen(drop, look, from, now, away) {
    const f = this.free.pop()
    if (!f) { this.overflow++; return null }
    const key = dropKey(drop.x, drop.z, drop.yaw)
    Object.assign(f, { tile: null, key, index: -1, offset: 0, homeX: from.x, homeZ: from.z, size: look.size, hue: look.hue, r: look.color[0], g: look.color[1], b: look.color[2] })
    Object.assign(f, { breath: (keyHash(key) % 628) / 100, lod: RUNGS, seg: null, lured: false, lure: null, caught: null, calm: -Infinity, pet: null, drop, under: this.cave !== null && from.y < this.cave.apron.y - 100 })
    f.rand = mulberry32(hash32(keyHash(key), 0x1e))
    this.drops.add(key)
    this._in = f.under ? this.cave.walk : null
    const s = this.seat(from.x, from.z, false)
    const to = s === null ? this._groundSpot(f, from.x, from.z, from.yaw) : this._spot(f, from.x, from.z, s, from.yaw)
    let hops = null
    let end = to
    if (away) {
      const r = between(f.rand, AWAY_M)
      const ax = from.x + Math.cos(from.yaw) * r, az = from.z - Math.sin(from.yaw) * r
      const as = this.seat(ax, az, false)
      if (as !== null) hops = this._lay(f, f.rand, to, this._spot(f, ax, az, as, from.yaw), Infinity)
      if (hops !== null && hops.length > 0) end = hops[hops.length - 1].to
    }
    const fall = Math.max(FREEZE_HOP_S, Math.sqrt((2 * Math.max(0, from.y - to.y)) / 9.8))
    const start = { x: from.x, y: from.y, z: from.z, h: from.y, wet: false, level: null, nx: 0, ny: 1, nz: 0, yaw: from.yaw }
    f.live = { ph: { kind: 'hop', dur: fall, from: start, to, rise: 0, bout: LEAP }, at: now, queue: [{ kind: 'sit', dur: NOTICE_S, at: to }, ...(hops ?? []), { kind: 'sit', dur: between(f.rand, SIT_S), at: end }], until: Infinity }
    this._pose(f, f.live.ph, 0)
    this._in = null
    this.loose.push(f)
    return f
  }

  _unloose(f) {
    const i = this.loose.indexOf(f)
    if (i < 0) throw new Error(`Frogs: loose frog ${f.key} is not in the loose list`)
    this.loose.splice(i, 1)
    f.pet = null
    f.under = false
    this.free.push(f)
  }

  /** Frog `f` ate the bug in the hand of `by` (null hers) on second `now`: grown by GROW (by MEAL.grow once a pet), loose under `drop` (by default where it is), that one's pet. */
  _feed(f, by, now, drop = null) {
    const home = f.tile !== null ? { x: f.homeX, z: f.homeZ } : null
    if (f.tile !== null) {
      if (!taken.has('frog', f.homeX, f.homeZ)) taken.add('frog', f.homeX, f.homeZ)
      this._unlist(f)
      this.oweTiles.add(f.tile)
      const list = f.tile.frogs
      list.splice(list.indexOf(f), 1)
      f.tile = null
      this.loose.push(f)
      f.drop = drop ?? { x: snap(f.x), z: snap(f.z), yaw: snap(f.yaw) }
      f.key = dropKey(f.drop.x, f.drop.z, f.drop.yaw)
      f.rand = mulberry32(hash32(keyHash(f.key), 0x1e))
      this.drops.add(f.key)
    }
    f.size *= f.pet === null ? GROW : 1 + MEAL.grow
    f.pet = { by, at: now }
    f.way = headway()
    if (f.live === null) this._startChase(f, now)
    f.lured = false
    f.lure = null
    this._startRejoin(f, now)
    if (by === null) this._tell(f, FED, now, home)
  }

  // --- the room ---------------------------------------------------------------

  /**
   * Loose frog `f` to the room as one anchor in `mode`: `[wire, T, x, y, z,
   * yaw, 0, mode, by, size, hue, r, g, b, dropX, dropZ, dropYaw, homeX,
   * homeZ]`, where it is (a DROP: where the hand let it go), its look, the
   * drop that keys it, and for a bed frog fed the home it is evicted from.
   * Nothing while a peer's anchor is being applied.
   */
  _tell(f, mode, T, home, at = f) {
    if (this.applying) return
    const d = f.drop
    this.outbox.push([dropWire('fg', f.key), snap(T), snap(at.x), snap(at.y), snap(at.z), snap(at.yaw), 0, mode, null, snap(f.size), snap(f.hue), snap(f.r), snap(f.g), snap(f.b), d.x, d.z, d.yaw, home ? snap(home.x) : null, home ? snap(home.z) : null])
  }

  /** The anchors owed since the last call, moved into `into`. For creature-net.js. */
  pending(into = []) {
    for (const a of this.outbox) into.push(a)
    this.outbox.length = 0
    return into
  }

  /** A peer's loose frog: let go (DROP) where their hand did, fed (FED) and following them, or taken (TOOK). For creature-net.js. */
  apply(anchor, now) {
    if (anchor.length !== 19) throw new Error(`Frogs: an anchor of ${anchor.length} fields, not 19: ${JSON.stringify(anchor)}`)
    const [, T, x, y, z, yaw, , mode, by, size, hue, r, g, b, dx, dz, dyaw, hx, hz] = anchor
    if (by === null) return
    if (![T, x, y, z, yaw, size, hue, r, g, b, dx, dz, dyaw].every(Number.isFinite)) throw new Error(`Frogs: an anchor short of its numbers: ${JSON.stringify(anchor)}`)
    const key = dropKey(dx, dz, dyaw)
    const f = this.loose.find((l) => l.key === key) ?? null
    const look = { size, hue, color: [r, g, b] }
    this.applying = true
    try {
      if (mode === DROP) {
        if (!this.drops.has(key)) this._loosen({ x: dx, z: dz, yaw: dyaw }, look, { x, y, z, yaw }, T, true)
      } else if (mode === FED) {
        if (f !== null && f.pet !== null) f.size = size / (1 + MEAL.grow)
        const fed = f ?? (hx !== null ? this._bedFrog(hx, hz) : null) ?? this._loosen({ x: dx, z: dz, yaw: dyaw }, { ...look, size: size / GROW }, { x, y, z, yaw }, T, false)
        if (fed !== null) this._feed(fed, by, now, { x: dx, z: dz, yaw: dyaw })
      } else if (mode === TOOK) {
        if (f !== null) this._unloose(f)
      } else throw new Error(`Frogs: no anchor mode ${mode}`)
    } finally {
      this.applying = false
    }
  }

  /** The lured sets owed since the last call, pushed onto `into` (creature-net.js): `[bedKey, 'fg', null, indices]`, one a bed. */
  pendingLured(into = []) {
    for (const set of this.owed) into.push(set)
    this.owed.length = 0
    return into
  }

  /** A peer's lured set for one of the beds: the frogs its hand has, kept from LURE_M on while that hand's lure is near them. */
  applyLured(set) {
    if (!Array.isArray(set) || set.length !== 4 || typeof set[0] !== 'string' || !Array.isArray(set[3])) throw new Error(`Frogs.applyLured: bad set ${JSON.stringify(set)}`)
    if (set[3].length === 0) this.luredIn.delete(set[0])
    else this.luredIn.set(set[0], { by: set[2], has: new Set(set[3]) })
  }

  /** Bed `t`'s lured set owed when the frogs her own hand has changed since the last sent and LURED_EVERY_S has passed, or when they are none now and were not. */
  _owe(t, now) {
    let mine = ''
    for (const f of t.frogs) if (f.lured && f.lure.by === null) mine += `${f.index},`
    if (mine === t.luredSent) return
    if (mine !== '' && now - t.luredAt < LURED_EVERY_S) return
    t.luredSent = mine
    t.luredAt = now
    this.owed.push([t.key, 'fg', null, mine === '' ? [] : mine.slice(0, -1).split(',').map(Number)])
  }

  /** The one-shots since the last call, each `{ sound, rule, x, y, z }`, drained. */
  voices(into) {
    for (const v of this.calls) into.push(v)
    this.calls.length = 0
    return into
  }

  /** What frog `f` did going from phrase `prev` to the one it is posed on: a hop begun, or a hop off dry ground that came down in the water. */
  _heard(f, prev, hx, hy, hz) {
    if (prev === null || f.ph === prev || Math.hypot(f.x - hx, f.y - hy, f.z - hz) > HEAR_M) return
    if (prev.kind === 'hop' && prev.to.wet && !prev.from.wet) this.calls.push({ sound: 'splash', rule: 'splash', x: prev.to.x, y: prev.to.level, z: prev.to.z })
    if (f.ph.kind === 'hop') this.calls.push(f.ph.croak ? { sound: Math.random() < 0.5 ? 'croak1' : 'croak2', rule: 'frogCroak', x: f.x, y: f.y, z: f.z } : { sound: 'frogBoing', rule: 'frogHop', x: f.x, y: f.y, z: f.z })
  }

  /** Whether frog `f` eats the bug or hob in her hand it is on: at its face (EAT), and hands.js gives it up. */
  _eats(f, now) {
    const l = f.lure
    // One fed from its bed is in the loose list the same frame, its bug still held: one meal a frame.
    if (!f.lured || l.by !== null || !MEALS.includes(l.kind) || (f.pet !== null && f.pet.at === now)) return false
    if (Math.hypot(l.x - f.x, l.z - f.z) > EAT.m || Math.abs(l.y - f.y) > EAT.dy || !this.eat(l)) return false
    this._feed(f, null, now)
    return true
  }

  /** Frog `f` into its tier's next instance, `counts` the instances written per tier, unless too small to be drawn from (hx, hy, hz). */
  _draw(f, counts, breath, bob, hx, hy, hz) {
    let sy = 1
    let sx = 1
    let sz = 1
    // The surface's bob, ridden while afloat.
    let lift = 0
    if (f.state === 'sit') {
      if (f.wet) {
        lift = BOB_AMP * Math.sin(bob + f.breath)
      } else {
        // The breath: a swell that is mostly height, a little girth.
        const s = BREATH_AMP * (0.5 + 0.5 * Math.sin(breath + f.breath))
        sy = 1 + s
        sx = sz = 1 + s * 0.4
      }
    }
    // The rung its apparent size calls for; past the ladder's foot it is not drawn, and on the card rung a frog this layer poses is LOD2 (only the sweep writes cards).
    f.lod = frogTier(f.size, Math.hypot(f.x - hx, f.y - hy, f.z - hz), f.lod)
    if (f.lod === RUNGS) return
    const t = Math.min(f.lod, LOD_TIERS - 1)
    const k = f.size / this.span
    _pos.set(f.x, f.y + lift, f.z)
    // Yaw about the world up, then that up tilted onto the ground's normal.
    _quat.setFromAxisAngle(UP, f.yaw)
    _tilt.setFromUnitVectors(UP, _nrm.set(f.nx, f.ny, f.nz))
    _quat.premultiply(_tilt)
    _scl.set(k * sx, k * sy, k * sz)
    _mat.compose(_pos, _quat, _scl)
    const tier = this.tiers[t]
    const w = this.gpuCounts[t] + counts[t]++
    _mat.toArray(tier.instanceMatrix.array, w * 16)
    const c = tier.instanceColor.array
    c[w * 3] = f.r; c[w * 3 + 1] = f.g; c[w * 3 + 2] = f.b
    this.hues[t].array[w] = f.hue
    if (this.anim === null) return
    const anim = this.animAttrs[t].array
    if (f.state === 'sit') writeAnim(this.anim.idle, (this.uIdle.value + f.breath / (2 * Math.PI)) % 1, idleWeight(f.t, f.ph.dur), anim, w * 4)
    else writeAnim(this.anim.hop, f.u, hopWeight(f.u), anim, w * 4)
  }

  // --- the GPU ----------------------------------------------------------------

  /** Frog `f` posed on its plan at the room's clock; its segment is current. */
  _sync(f) {
    f.sat = this.now
    const e = this.now - f.seg.start
    const ph = Frogs._phraseAt(f.seg.phrases, e)
    this._pose(f, ph, e - ph.start)
  }

  /** `f`'s segment laid into its row of the table: each phrase at its spot, a hop running on to the spot of the phrase after it. */
  _layRow(f) {
    const phrases = f.seg.phrases
    const out = phrases.map((ph, i) => {
      const hop = ph.kind === 'hop'
      if (hop && i === phrases.length - 1) throw new Error(`Frogs: segment of ${f.key} ends in a hop`)
      const at = hop ? ph.from : ph.at
      return { kind: hop ? HOP : at.wet ? SIT_WET : SIT, start: ph.start, dur: ph.dur, apex: hop ? ph.rise : 0, yaw: at.yaw, a: at, b: null }
    })
    this.table.write(f.id + 1, f.seg.start, f.size / this.span, out)
    f.rowSeg = f.seg
  }

  /** The second after `now` frog `f`'s plan next turns a phrase or a segment. */
  static _wakeAfter(seg, now) {
    const e = now - seg.start
    for (const ph of seg.phrases) if (ph.start > e) return seg.start + ph.start
    return seg.start + GRID_S
  }

  /**
   * Every frog on its plan whose phrase or segment has turned: the next segment planned and its row laid, the hop it began (or the splash it made) told to the ear. `all`: the clock went back, so every one is due.
   */
  _wake(now, all, hx, hy, hz) {
    let next = Infinity
    for (const t of this.tiles.values()) {
      for (let i = t.frogs.length - 1; i >= 0; i--) {
        const f = t.frogs[i]
        if (f.cpu) continue
        if (!all && now < f.wake) {
          if (f.wake < next) next = f.wake
          continue
        }
        if (f.seg === null || now < f.seg.start || now >= f.seg.start + GRID_S) {
          const seg = this._segment(f, Math.floor((now - f.offset) / GRID_S))
          if (seg === null) { this._drop(f); continue }
          f.seg = seg
        }
        if (f.rowSeg !== f.seg) this._layRow(f)
        this._sync(f)
        this._heard(f, f.sounded, hx, hy, hz)
        f.sounded = f.ph
        if (!f.gpu) { f.gpu = true; this.listDirty = true }
        f.wake = Frogs._wakeAfter(f.seg, now)
        if (f.wake < next) next = f.wake
        this.hopped = true
      }
    }
    this.nextWake = next
  }

  /** Frog `f`, posed at `now`, taken off the shader: this layer poses it each frame until it is back on its plan. */
  _toCpu(f, hx, hy, hz) {
    this._heard(f, f.sounded, hx, hy, hz)
    f.gpu = false
    f.cpu = true
    this.cpu.add(f)
    this.oweTiles.add(f.tile)
    this.listDirty = true
  }

  /** Frog `f` is back on its plan: the shader has it from the next wake. */
  _toGpu(f) {
    f.cpu = false
    this.cpu.delete(f)
    f.sounded = f.ph
    f.wake = -Infinity
    this.nextWake = -Infinity
    this.listDirty = true
  }

  /** Every bed frog onto this layer's pose (the tint row swaps the tiers' material for flat colours that know nothing of the table), or back to the shader. */
  _setCpuAll(on) {
    this.cpuAll = on
    this.listDirty = true
    this.nextWake = -Infinity
    for (const t of this.tiles.values()) {
      for (const f of t.frogs) {
        if (on) {
          if (f.gpu) { this._sync(f); f.gpu = false }
          f.cpu = false
        } else if (f.live !== null || f.caught !== null) {
          f.cpu = true
          this.cpu.add(f)
        } else {
          f.cpu = false
          f.wake = -Infinity
        }
      }
    }
    if (on) {
      this.cpu.clear()
      for (const f of this.carded) this._uncard(f)
      for (let k = 0; k < LOD_TIERS; k++) {
        this.rowAttrs[k].array.fill(0, 0, this.gpuCounts[k])
        this.rowAttrs[k].needsUpdate = true
        this.gpuCounts[k] = 0
      }
    }
  }

  /**
   * One frame of a frog this layer poses: its plan (or its live phrases) advanced to `now`, a villager's hold, the ear, a lure noticed or lost, a bug eaten. False once the frog is gone (home turned to stone, or eaten and loose now).
   */
  _step(f, lures, claims, now, mates, hx, hy, hz) {
    if (f.seg === null || now < f.seg.start || now >= f.seg.start + GRID_S) {
      const seg = this._segment(f, Math.floor((now - f.offset) / GRID_S))
      if (seg === null) { this._drop(f); return false }
      f.seg = seg
    }
    // Posed first, so a lure is measured from where the frog is, on its plan or off it; a lure noticed or lost this frame changes what plays from the next.
    const prev = f.ph
    if (f.live === null || !this._live(f, now)) {
      const ph = Frogs._phraseAt(f.seg.phrases, now - f.seg.start)
      this._pose(f, ph, now - f.seg.start - ph.start)
    }
    const claim = claims.get(f.key)
    if (claim !== undefined || f.caught !== null) this._caught(f, claim, now)
    this._heard(f, prev, hx, hy, hz)
    if (f.caught === null) {
      this._notice(f, lures, now, mates)
      // Fed, it is loose now, and drawn with them.
      if (this._eats(f, now)) return false
    }
    return true
  }

  /** The bed frogs on their plans that a villager's hold in `claims` is on, or a lure in `lures` is near enough to notice, taken off the shader. Frogs far from every lure are not looked at. */
  _reach(lures, claims, now, mates, hx, hy, hz) {
    for (const key of claims.keys()) {
      const f = this.byKey.get(key)
      if (f !== undefined && !f.cpu) this._toCpu(f, hx, hy, hz)
    }
    const reach = LURE_FORGET_M + EXCURSION_M + TILE
    for (const t of this.tiles.values()) {
      const cx = (t.tx + 0.5) * TILE, cz = (t.tz + 0.5) * TILE
      if (!lures.some((l) => LURES.includes(l.kind) && Math.hypot(cx - l.x, cz - l.z) <= reach)) continue
      for (const f of t.frogs) {
        if (f.cpu || !f.gpu) continue
        this._notice(f, lures, now, mates)
        if (f.lured) this._toCpu(f, hx, hy, hz)
      }
    }
  }

  /** The bed frogs on their plans sorted onto the rungs their apparent size calls for: each mesh tier's head of the arrays (row, tint, hue, breath) rewritten if the list changed, and the cards kept (_card) or put away. */
  _sweep(hx, hy, hz, now) {
    this.sweepNo++
    this.sweptAt = now
    this.sweptHead.x = hx; this.sweptHead.y = hy; this.sweptHead.z = hz
    this.hopped = false
    const force = this.listDirty
    this.listDirty = false
    const counts = this._counts
    counts.fill(0)
    const changed = this.tiers.map(() => false)
    for (const t of this.tiles.values()) {
      for (const f of t.frogs) {
        if (!f.gpu) continue
        if (f.sat !== now) this._sync(f)
        f.lod = frogTier(f.size, Math.hypot(f._x - hx, f._y - hy, f._z - hz), f.lod)
        if (f.lod === RUNGS) continue
        if (f.lod === CARD && this.cardReady) { this._card(f); continue }
        const k = Math.min(f.lod, LOD_TIERS - 1)
        const i = counts[k]++
        const rows = this.rowAttrs[k].array
        if (force || rows[i] !== f.id + 1) {
          rows[i] = f.id + 1
          this.breathAttrs[k].array[i] = f.breath
          this.hues[k].array[i] = f.hue
          const c = this.tiers[k].instanceColor.array
          c[i * 3] = f.r; c[i * 3 + 1] = f.g; c[i * 3 + 2] = f.b
          changed[k] = true
        }
      }
    }
    for (let k = 0; k < LOD_TIERS; k++) {
      const rows = this.rowAttrs[k].array
      for (let i = counts[k]; i < this.gpuCounts[k]; i++) { rows[i] = 0; changed[k] = true }
      if (changed[k]) {
        this.rowAttrs[k].needsUpdate = true
        this.breathAttrs[k].needsUpdate = true
        this.hues[k].needsUpdate = true
        this.tiers[k].instanceColor.needsUpdate = true
      }
      this.gpuCounts[k] = counts[k]
    }
    for (const f of this.carded) if (f.cardStamp !== this.sweepNo) this._uncard(f)
  }

  /** The matrix the shader draws instance `i` of tier `k` with, in doubles from the texels it reads: the JS twin of MOTION_GLSL, for the gates. A CPU row gives the tier's own matrix, an emptied row a zero scale. */
  matrixAt(k, i, out) {
    const row = this.rowAttrs[k].array[i]
    if (row === 0) return out.fromArray(this.tiers[k].instanceMatrix.array, i * 16)
    const d = this.table.data
    const o = row * ROW_W * 4
    if (d[o + 3] === 0) return out.makeScale(0, 0, 0)
    const T = this.table.uniforms.uMotionT.value
    const e = (T.x - d[o]) + (T.y - d[o + 1])
    let p = 0
    while (p + 1 < d[o + 3] && d[o + 4 + (p + 1) * 16] <= e) p++
    const q = o + 4 + p * 16
    const kind = d[q + 2]
    let x = d[q + 4], y = d[q + 5], z = d[q + 6], yaw = d[q + 7]
    let nx = d[q + 12], ny = d[q + 13], nz = d[q + 14]
    let sx = 1, sy = 1, sz = 1
    const breath = this.uPhase.value.x + this.breathAttrs[k].array[i]
    if (kind === HOP) {
      const dur = d[q + 1]
      const u = dur > 0 ? Math.min(1, Math.max(0, (e - d[q]) / dur)) : 1
      const tx = d[q + 20], ty = d[q + 21], tz = d[q + 22], tyaw = d[q + 23]
      x += (tx - x) * u; z += (tz - z) * u
      y += (ty - y) * u + 4 * d[q + 3] * u * (1 - u)
      const v = Math.min(1, u * 1.5)
      nx += (d[q + 28] - nx) * v; ny += (d[q + 29] - ny) * v; nz += (d[q + 30] - nz) * v
      const ddx = tx - d[q + 4], ddz = tz - d[q + 6]
      const head = ddx * ddx + ddz * ddz < 1e-18 ? tyaw : Math.atan2(-ddz, ddx)
      yaw = head + Math.atan2(Math.sin(tyaw - head), Math.cos(tyaw - head)) * v
    } else if (kind === SIT_WET) {
      y += BOB_AMP * Math.sin(this.uPhase.value.y + this.breathAttrs[k].array[i])
    } else {
      const s = BREATH_AMP * (0.5 + 0.5 * Math.sin(breath))
      sx = sz = 1 + s * 0.4
      sy = 1 + s
    }
    const l = Math.hypot(nx, ny, nz)
    _quat.setFromAxisAngle(UP, yaw)
    _tilt.set(nz / l, 0, -nx / l, 1 + ny / l).normalize()
    _quat.premultiply(_tilt)
    const kk = d[o + 2]
    return out.compose(_pos.set(x, y, z), _quat, _scl.set(kk * sx, kk * sy, kk * sz))
  }

  /** `now` the room's clock in seconds; `lures`: hands.js lures() this frame and the hobs', the spiders, butterflies, grasshoppers and hobs among them chased; `claims` the villagers' holds on frogs by key; `peers` the peers' heads `{ x, y, z, by }`, which their pets follow. */
  update(hx, hy, hz, now, lures = NO_LURES, claims = NO_CLAIMS, peers = NO_LURES) {
    if (!Number.isFinite(now)) throw new Error(`Frogs.update: bad time ${now}`)
    const rewound = now < this.now
    this.head.x = hx
    this.head.z = hz
    this.now = now
    this.me.x = hx; this.me.y = hy; this.me.z = hz
    const mates = this.mates
    mates.length = 0
    mates.push(this.me)
    for (const p of peers) mates.push({ kind: 'mate', x: p.x, y: p.y, z: p.z, by: p.by })
    this.calls.length = 0
    if (Math.hypot(hx - this.walkedX, hz - this.walkedZ) > WALK_M) {
      walkTiles(this.tiles, hx, hz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t))
      this.walkedX = hx
      this.walkedZ = hz
    }
    if (this.ground && this.ground.groundVersion !== this.gver) {
      this.gver = this.ground.groundVersion
      this._reseat()
    }

    // The tint row (critters.js): each tier's mesh onto its flat colour, or all of them back onto the one shared material.
    if (this.tinted !== tierTintOn()) {
      this.tinted = tierTintOn()
      this.tiers.forEach((m, k) => { m.material = this.tinted ? TIER_TINTS[LOD_LEVELS[k]] : this.material })
    }
    if (this.tinted !== this.cpuAll) this._setCpuAll(this.tinted)

    const breath = (now * Math.PI * 2) / BREATH_S
    const bob = (now * Math.PI * 2) / BOB_S
    this.table.setTime(now)
    this.uPhase.value.set(breath % (Math.PI * 2), bob % (Math.PI * 2))
    // Frogs are planned and stepped while the asset loads; they are drawn only once it has landed.
    if (this.anim !== null) this.uIdle.value = (now / this.anim.idle.seconds) % 1
    const counts = this.tiers.map(() => 0)

    if (this.cpuAll) {
      for (const t of this.tiles.values()) {
        // Backwards, because a frog whose home has turned to stone leaves the list mid-walk.
        for (let i = t.frogs.length - 1; i >= 0; i--) {
          const f = t.frogs[i]
          if (this._step(f, lures, claims, now, mates, hx, hy, hz)) this._draw(f, counts, breath, bob, hx, hy, hz)
        }
        this._owe(t, now)
      }
    } else {
      if (rewound || now >= this.nextWake) this._wake(now, rewound, hx, hy, hz)
      if (lures.length > 0 || claims.size > 0) this._reach(lures, claims, now, mates, hx, hy, hz)
      const list = this.cpuTmp
      list.length = 0
      for (const f of this.cpu) list.push(f)
      for (const f of list) {
        if (!this._step(f, lures, claims, now, mates, hx, hy, hz)) continue
        if (f.live === null && f.caught === null && !f.lured) this._toGpu(f)
      }
      // Frogs back on their plans are laid and counted this frame, not the next.
      if (now >= this.nextWake) this._wake(now, false, hx, hy, hz)
      const sh = this.sweptHead
      if (this.listDirty || rewound || Math.hypot(hx - sh.x, hy - sh.y, hz - sh.z) >= SWEEP_M || (this.hopped && now - this.sweptAt >= SWEEP_S)) this._sweep(hx, hy, hz, now)
      for (const f of this.cpu) this._draw(f, counts, breath, bob, hx, hy, hz)
      for (const t of this.oweTiles) {
        this._owe(t, now)
        if (t.luredSent === '' && !t.frogs.some((f) => f.lured)) this.oweTiles.delete(t)
      }
    }
    for (let i = this.loose.length - 1; i >= 0; i--) {
      const f = this.loose[i]
      const hers = f.pet !== null && f.pet.by === null && this.her !== null
      const dist = Math.hypot(f.x - hx, f.z - hz)
      if (!hers && dist > RADIUS) { this._unloose(f); continue }
      // Underground, one not under with her takes the apron for her.
      this._in = f.under ? this.cave.walk : null
      // Past KEEP_UP.m on the overworld her pet has lost her, and sits where it is until she comes back.
      const m = this.cave === null || f.under ? (hers && !f.under && dist > KEEP_UP.m ? _her.set(f.x, f.y, f.z) : _her.set(hx, hy, hz)) : this.cave.apron
      this.me.x = m.x; this.me.y = m.y; this.me.z = m.z
      const prev = f.ph
      this._live(f, now)
      this._heard(f, prev, hx, hy, hz)
      this._notice(f, lures, now, mates)
      this._eats(f, now)
      const to = hers && (this.cave === null || f.under) ? this.her.keepUp(f.way, f.x, f.z, dist > LURE_M, now, (x, z) => this.seat(x, z, false) !== null) : null
      if (to !== null) {
        f.live = { ph: { kind: 'sit', dur: 0, at: this._spot(f, to.x, to.z, this.seat(to.x, to.z, false), bearing(to, this.me)) }, at: now, queue: null, until: Infinity }
        this._pose(f, f.live.ph, 0)
      }
      this._draw(f, counts, breath, bob, hx, hy, hz)
    }
    this._in = null
    this.me.x = hx; this.me.y = hy; this.me.z = hz
    // A tier that held nothing in its tail and holds nothing is not re-uploaded.
    this.tiers.forEach((tier, k) => {
      if (counts[k] > 0 || this.tails[k] > 0) {
        tier.instanceMatrix.needsUpdate = true
        tier.instanceColor.needsUpdate = true
        this.hues[k].needsUpdate = true
        this.animAttrs[k].needsUpdate = true
      }
      this.tails[k] = counts[k]
      tier.count = this.gpuCounts[k] + counts[k]
      tier.visible = tier.count > 0
    })
    this.table.flush()
    this.stats.alive = MAX - this.free.length
    this.stats.tiles = this.tiles.size
    this.stats.overflow = this.overflow
  }

  dispose() {
    this.batch.parent?.remove(this.batch)
    for (const f of this.carded) this._uncard(f)
    for (const tier of this.tiers) tier.geometry.dispose()
    this.material.map?.dispose()
    this.material.dispose()
    this.table.dispose()
    this.anim?.texture.dispose()
  }
}
