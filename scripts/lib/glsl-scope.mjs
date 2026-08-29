// ---------------------------------------------------------------------------
// A same-scope GLSL redeclaration scanner, shared by the gates that read shader
// source out of JS template literals.
//
// It lives here rather than in one gate because two gates need it and neither
// owns it: scripts/check-daynight.mjs scans the live shaders, and
// archive/aurora-mesh/check-aurora-mesh.mjs scans the archived band mesh. That
// direction matters -- the archive may import from the tree, never the reverse.
// ---------------------------------------------------------------------------

const TYPES = 'float|int|uint|bool|vec2|vec3|vec4|ivec2|ivec3|ivec4|uvec2|uvec3|uvec4|mat2|mat3|mat4'
// One shader at a time, not one file at a time: the vertex and fragment
// shaders are separate translation units that legitimately declare the same
// varying names, and scanning the whole JS file makes every varying look like
// a duplicate. So: pull out every template literal that contains a main(),
// which is exactly the set of shader sources, and scan each on its own.
export const shadersIn = (src) =>
  (src.match(/`[^`]*\bvoid\s+main\s*\(\s*\)[^`]*`/g) || []).map((t) => t.slice(1, -1))
// Preprocessor branches are not duplicates: water.js declares fogAmt once
// under #ifdef FOG_EXP2 and once under #else, and only one of those is ever
// compiled. Keep the first branch of every conditional and drop the rest --
// crude, but it is the right answer for this question, and the alternative is
// evaluating the preprocessor, which is a compiler.
const stripPre = (glsl) => {
  const out = []
  const skip = []
  for (const line of glsl.split('\n')) {
    const t = line.trim()
    if (/^#\s*(if|ifdef|ifndef)\b/.test(t)) { skip.push(false); continue }
    if (/^#\s*(else|elif)\b/.test(t)) { if (skip.length) skip[skip.length - 1] = true; continue }
    if (/^#\s*endif\b/.test(t)) { skip.pop(); continue }
    if (t.startsWith('#')) continue
    out.push(skip.some(Boolean) ? '' : line)
  }
  return out.join('\n')
}
export const redeclarations = (glsl) => {
  const clean = stripPre(glsl).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
  const bad = []
  // The synthetic outermost Set is the shader's global scope, so a uniform
  // and a global of the same name are caught too.
  const stack = [new Set()]
  const re = new RegExp(
    `[{}]|\\bfor\\s*\\(|\\b(?:uniform|attribute|varying|in|out|const)?\\s*(?:${TYPES})\\s+([A-Za-z_]\\w*)\\s*(?=[=;,)\\[])`,
    'g')
  let m
  let forDepth = -1
  while ((m = re.exec(clean))) {
    if (m[0] === '{') stack.push(new Set())
    else if (m[0] === '}') { if (stack.length > 1) stack.pop() }
    else if (m[0].trimStart().startsWith('for')) forDepth = stack.length
    else {
      // Anything declared while a for-header is open belongs to the loop.
      if (forDepth === stack.length) { forDepth = -1; continue }
      const scope = stack[stack.length - 1]
      if (scope.has(m[1])) bad.push(m[1])
      else scope.add(m[1])
    }
  }
  return bad
}
