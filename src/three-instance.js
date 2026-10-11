// Resolved once per page load, at import time -- not patched after the fact.
// A-Frame's CDN <script> tags are classic scripts in <head>, which run and set
// window.AFRAME before any <script type="module"> on the same page begins
// evaluating imports, so on an A-Frame page this always sees AFRAME.THREE
// already in place. Pages that never load A-Frame (v1, gen-* benches, node
// gates) import npm three here, and only here: the build binds every other
// `from 'three'` to this module (vite.config.js threeIsTheInstance), so the
// world page never fetches the package.
const THREE = typeof window !== 'undefined' && window.AFRAME ? window.AFRAME.THREE : await import('three')

export default THREE
