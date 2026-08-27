// ---------------------------------------------------------------------------
// One registry over both kinds of aurora, so the lab page keeps one import block and one set of lookups.
//
// The page currently imports ALGORITHMS, DEFAULT_ALGORITHM, SCENE_GROUPS, algorithmById, groupsFor, paramsFor and defaultsFor from algorithms.js. This module exports all seven under the same names with the geometry entry folded in, so the integration is a change of import path plus the handful of places that actually have to know which kind is running. Everything that merely asks "what are this algorithm's groups" keeps working untouched.
//
// It imports nothing that imports three.js. That is deliberate and load-bearing: scripts/check-aurora-lab.mjs dynamically imports the lab's schema side into Node, where a WebGL import at module scope fails the whole gate. The class lives in curtains.js and the entry lives in params.js precisely so this file can stay on the safe side of that line.
// ---------------------------------------------------------------------------

import {
  ALGORITHMS as SHADER_ALGORITHMS,
  DEFAULT_ALGORITHM as SHADER_DEFAULT,
  SCENE_GROUPS,
  algorithmById as shaderById,
  groupsFor as shaderGroupsFor,
  paramsFor as shaderParamsFor,
  defaultsFor as shaderDefaultsFor,
} from '../algorithms.js'

import { CURTAIN_ENTRY, curtainGroups, curtainParams, curtainDefaults } from './params.js'

export { SCENE_GROUPS }

export const CURTAIN_ID = CURTAIN_ENTRY.id

// Last in the list rather than first: the raymarch is the thing being designed and the geometry version is the fallback, so the picker should open on the former and you should have to go and choose the latter.
export const ALGORITHMS = [ ...SHADER_ALGORITHMS, CURTAIN_ENTRY ]

export const DEFAULT_ALGORITHM = SHADER_DEFAULT

export function isCurtain( id ) {
  return id === CURTAIN_ID
}

export function algorithmById( id ) {
  if ( isCurtain( id ) ) return CURTAIN_ENTRY
  return shaderById( id )
}

// The geometry algorithm gets SCENE_GROUPS and nothing else shared. It has no march, so step count, step bias, dither, the perspective divisor and the field scale would all be sliders that move nothing -- which is the exact silent failure the schema exists to prevent -- and the deposition and belt knobs that do survive survive in different units. See the header of params.js.
export function groupsFor( id ) {
  if ( isCurtain( id ) ) return curtainGroups()
  return shaderGroupsFor( id )
}

export function paramsFor( id ) {
  if ( isCurtain( id ) ) return curtainParams()
  return shaderParamsFor( id )
}

export function defaultsFor( id ) {
  if ( isCurtain( id ) ) return curtainDefaults()
  return shaderDefaultsFor( id )
}
