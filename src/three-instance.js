import * as npmThree from 'three'

// Resolved once per page load, at import time -- not patched after the fact.
// A-Frame's CDN <script> tags are classic scripts in <head>, which run and set
// window.AFRAME before any <script type="module"> on the same page begins
// evaluating imports, so on an A-Frame page this always sees AFRAME.THREE
// already in place. Pages that never load A-Frame (v1, desktop v2, gen-*
// benches) fall through to npm three.js, unchanged from before this file
// existed. Both namespaces expose the same named properties, so call sites
// (THREE.Vector3, THREE.Mesh, ...) never need to change, only the import line.
const THREE = (typeof window !== 'undefined' && window.AFRAME?.THREE) ? window.AFRAME.THREE : npmThree

export default THREE
