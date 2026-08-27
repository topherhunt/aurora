// ---------------------------------------------------------------------------
// The mesh. A grid per curtain per leaf, in PARAMETER space only: the vertex shader decides where every vertex actually is, so this file never computes a world position and never needs rebuilding when the shape changes. It rebuilds only when one of the four counts moves.
//
// The position attribute holds the parameter triple rather than a location. three.js wants a position attribute to exist, and there is no honest world position to put there -- the vertices are placed by a curve that depends on time. Bounding volumes are therefore meaningless, which is why the caller sets frustumCulled false and provides its own bounding sphere.
// ---------------------------------------------------------------------------

import * as THREE from 'three'

// Kilometres to scene units. The lab puts its mountains at 1500 and its star sphere at 15000, so this is chosen to land a 90 km hem at 540 units and a 780 km curtain at 4680: above the terrain, well inside the stars. It is a constant rather than a slider because changing it changes what every kilometre-denominated param means, and a panel where the units move is a panel you cannot tune.
export const WORLD_PER_KM = 6.0

export function buildCurtainGeometry( curtains, segs, rows, leaves ) {

  if ( !( curtains >= 1 ) || !( segs >= 1 ) || !( rows >= 2 ) || !( leaves >= 1 ) ) {
    throw new Error( 'aurora-curtains: bad geometry counts ' + [ curtains, segs, rows, leaves ].join( ', ' ) )
  }

  const cols = segs + 1
  const sheets = curtains * leaves
  const perSheet = cols * rows
  const vertCount = sheets * perSheet
  const quadCount = sheets * segs * ( rows - 1 )
  const idxCount = quadCount * 6

  const position = new Float32Array( vertCount * 3 )
  const aU = new Float32Array( vertCount )
  const aV = new Float32Array( vertCount )
  const aCurtain = new Float32Array( vertCount )
  const aLeaf = new Float32Array( vertCount )

  // Uint16 runs out at 65536 vertices, which the top of the slider ranges passes comfortably. Picking the width from the actual count rather than always using 32-bit halves the index bandwidth in the common case, and index bandwidth is one of the few things on a tiler that is not fill rate.
  const index = vertCount > 65535 ? new Uint32Array( idxCount ) : new Uint16Array( idxCount )

  let v = 0
  let ii = 0

  for ( let c = 0; c < curtains; c++ ) {
    for ( let l = 0; l < leaves; l++ ) {

      const base = v

      for ( let s = 0; s < cols; s++ ) {
        const u = s / segs
        for ( let r = 0; r < rows; r++ ) {
          const w = r / ( rows - 1 )
          position[ v * 3 + 0 ] = u
          position[ v * 3 + 1 ] = w
          position[ v * 3 + 2 ] = c
          aU[ v ] = u
          aV[ v ] = w
          aCurtain[ v ] = c
          aLeaf[ v ] = l
          v++
        }
      }

      for ( let s = 0; s < segs; s++ ) {
        for ( let r = 0; r < rows - 1; r++ ) {
          const a = base + s * rows + r
          const b = a + rows
          index[ ii++ ] = a
          index[ ii++ ] = b
          index[ ii++ ] = b + 1
          index[ ii++ ] = a
          index[ ii++ ] = b + 1
          index[ ii++ ] = a + 1
        }
      }
    }
  }

  if ( v !== vertCount || ii !== idxCount ) {
    throw new Error( 'aurora-curtains: geometry fill mismatch, wrote ' + v + ' of ' + vertCount + ' vertices and ' + ii + ' of ' + idxCount + ' indices' )
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute( 'position', new THREE.BufferAttribute( position, 3 ) )
  geo.setAttribute( 'aU', new THREE.BufferAttribute( aU, 1 ) )
  geo.setAttribute( 'aV', new THREE.BufferAttribute( aV, 1 ) )
  geo.setAttribute( 'aCurtain', new THREE.BufferAttribute( aCurtain, 1 ) )
  geo.setAttribute( 'aLeaf', new THREE.BufferAttribute( aLeaf, 1 ) )
  geo.setIndex( new THREE.BufferAttribute( index, 1 ) )

  // A sphere large enough to hold anything the sliders can produce, so that if something upstream does test it the answer is always visible rather than always culled. computeBoundingSphere on the parameter-space positions would return a sphere of radius 1 around the origin, and the mesh would vanish the moment anything trusted it.
  geo.boundingSphere = new THREE.Sphere( new THREE.Vector3( 0, 0, 0 ), 60000 )

  geo.userData.curtainStats = { vertices: vertCount, triangles: quadCount * 2 }

  return geo
}
