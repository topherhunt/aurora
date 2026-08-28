// ---------------------------------------------------------------------------
// The shared animation set: walk, run, idle, sit. Each clip is a function of
// a 0..1 phase plus a small parameter object -- not authored keyframes -- so
// it applies to every character's identical rig unmodified, and "tuning" is
// dragging sliders in gen-anim.html rather than re-posing per character.
//
// Every rotation is a single Euler axis per bone. That's a deliberate
// simplification for an N64-era low-poly walk cycle, not an oversight: a
// second axis (torso twist, foot roll) is a straightforward addition here if
// a clip needs it later, but nothing so far does.
// ---------------------------------------------------------------------------

export function axisAngleQuat(x, y, z, angle) {
  const len = Math.hypot(x, y, z) || 1
  const s = Math.sin(angle / 2) / len
  return [x * s, y * s, z * s, Math.cos(angle / 2)]
}

// rotX(bone, radians) rotates about the bone's local X axis (sagittal swing
// -- the axis a leg or arm naturally swings on when walking forward).
function rotX(radians) { return axisAngleQuat(1, 0, 0, radians) }
export function rotZ(radians) { return axisAngleQuat(0, 0, 1, radians) }

// Hamilton product, a (x,y,z,w) times b (x,y,z,w) -- composes two rotations,
// applying b first then a. Used by bakeClip to compose an animated delta
// (expressed in the bone's original vertical-rest-pose convention) with an
// arm bone's real rest rotation (rig.mjs, T-pose arms are horizontal at
// rest), and safe to call on every bone unconditionally: multiplying by the
// identity quaternion (every non-arm bone's rest rotation) is a no-op.
export function quatMultiply([ax, ay, az, aw], [bx, by, bz, bw]) {
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]
}

export const DEFAULT_PARAMS = {
  idle: { breathe: 0.015, sway: 0.02, cadence: 0.3 },
  walk: { stride: 0.55, kneeBend: 0.9, armSwing: 0.4, bounce: 0.025, cadence: 1.0 },
  run: { stride: 0.9, kneeBend: 1.3, armSwing: 0.7, bounce: 0.06, cadence: 1.7 },
  sit: { kneeBend: 1.55, hipBend: 1.4, torsoLean: 0.08 },
}

// Each clip: (phase in [0,1), params) -> { rot: {boneName: quat}, hipsBobY? }
// hipsBobY is a Y offset added to Hips's rest translation.
const CLIPS = {
  idle(phase, p) {
    const s = Math.sin(phase * 2 * Math.PI)
    return {
      rot: {
        Chest: rotZ(s * p.sway * 0.3),
        Head: rotZ(-s * p.sway * 0.5),
      },
      hipsBobY: s * p.breathe,
    }
  },

  walk(phase, p) {
    const t = phase * 2 * Math.PI
    const s = Math.sin(t), s2 = Math.sin(t + Math.PI)
    return {
      rot: {
        UpperLegR: rotX(s * p.stride),
        UpperLegL: rotX(s2 * p.stride),
        LowerLegR: rotX(Math.max(0, -s) * p.kneeBend),
        LowerLegL: rotX(Math.max(0, -s2) * p.kneeBend),
        UpperArmR: rotX(s2 * p.armSwing),
        UpperArmL: rotX(s * p.armSwing),
        Chest: rotZ(-s * 0.05),
      },
      hipsBobY: Math.abs(Math.sin(t * 2)) * p.bounce,
    }
  },

  run(phase, p) {
    const t = phase * 2 * Math.PI
    const s = Math.sin(t), s2 = Math.sin(t + Math.PI)
    return {
      rot: {
        UpperLegR: rotX(s * p.stride),
        UpperLegL: rotX(s2 * p.stride),
        LowerLegR: rotX(Math.max(0, -s) * p.kneeBend + 0.2),
        LowerLegL: rotX(Math.max(0, -s2) * p.kneeBend + 0.2),
        UpperArmR: rotX(s2 * p.armSwing),
        UpperArmL: rotX(s * p.armSwing),
        LowerArmR: rotX(-0.9),
        LowerArmL: rotX(-0.9),
        Chest: rotZ(-s * 0.09),
      },
      hipsBobY: Math.abs(Math.sin(t * 2)) * p.bounce,
    }
  },

  // Static pose, not time-varying -- baked as two identical keyframes so the
  // glTF sampler still has a valid [times[0], times[last]] span.
  sit(_phase, p) {
    return {
      rot: {
        UpperLegR: rotX(-p.hipBend), UpperLegL: rotX(-p.hipBend),
        LowerLegR: rotX(p.kneeBend), LowerLegL: rotX(p.kneeBend),
        Chest: rotX(p.torsoLean),
      },
      hipsBobY: -0.35,
    }
  },
}

export const CLIP_NAMES = Object.keys(CLIPS)

// The live-preview path (gen-anim.html) and the bake path both need to call
// a clip's pose function -- exported rather than exposing CLIPS itself so
// there's one place that validates the name.
export function evaluateClip(name, phase, params) {
  const fn = CLIPS[name]
  if (!fn) throw new Error(`unknown clip "${name}"`)
  return fn(phase, params)
}

/**
 * Bakes one clip to gltf-writer's animation format for a given skeleton
 * (rig.buildSkeleton's output). `frames` is samples per cycle; `duration` is
 * seconds per cycle at params.cadence === 1 (cadence scales playback speed,
 * not the bake -- the runtime AnimationMixer's timeScale handles that).
 */
export function bakeClip(name, skeleton, params = DEFAULT_PARAMS[name], { frames = 24, duration = 1.0 } = {}) {
  if (!CLIPS[name]) throw new Error(`unknown clip "${name}"`)
  const boneIndex = new Map(skeleton.bones.map((b, i) => [b.name, i]))
  const hipsI = boneIndex.get('Hips')
  const hipsRestY = skeleton.translations[hipsI * 3 + 1]

  const isStatic = name === 'sit'
  const sampleCount = isStatic ? 2 : frames
  const times = Array.from({ length: sampleCount }, (_, i) => (i / (sampleCount - 1)) * duration)

  const rotTracks = new Map() // boneName -> values[]
  const hipsY = []
  for (let i = 0; i < sampleCount; i++) {
    const phase = isStatic ? 0 : i / frames
    const { rot, hipsBobY = 0 } = evaluateClip(name, phase, params)
    for (const [bone, quat] of Object.entries(rot)) {
      const idx = boneIndex.get(bone)
      if (idx === undefined) throw new Error(`clip "${name}" references unknown bone "${bone}"`)
      // glTF rotation tracks are absolute, not additive to the bone's rest
      // rotation -- composing here is what keeps a T-pose arm bone's swing
      // meaning "swing this far off rest" instead of overwriting its rest
      // orientation outright. A no-op for every bone whose rest rotation is
      // identity (everything but the six arm bones -- rig.mjs).
      const rest = [skeleton.rotations[idx * 4], skeleton.rotations[idx * 4 + 1], skeleton.rotations[idx * 4 + 2], skeleton.rotations[idx * 4 + 3]]
      const composed = quatMultiply(rest, quat)
      if (!rotTracks.has(bone)) rotTracks.set(bone, [])
      rotTracks.get(bone).push(...composed)
    }
    hipsY.push(hipsRestY + hipsBobY)
  }

  const tracks = []
  for (const [bone, values] of rotTracks) {
    const idx = boneIndex.get(bone)
    if (idx === undefined) throw new Error(`clip "${name}" references unknown bone "${bone}"`)
    tracks.push({ bone: idx, path: 'rotation', times, values })
  }
  const hipsTx = skeleton.translations[hipsI * 3], hipsTz = skeleton.translations[hipsI * 3 + 2]
  tracks.push({ bone: hipsI, path: 'translation', times, values: hipsY.flatMap((y) => [hipsTx, y, hipsTz]) })

  return { name, duration, tracks }
}
