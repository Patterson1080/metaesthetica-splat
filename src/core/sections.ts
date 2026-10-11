import { Mat4, Quat, Vec3, type GSplatComponent } from 'playcanvas'
import { MAX_SECTIONS, type SectionBox } from './scene'

type Mode = 'keep' | 'cut'

/** The enabled boxes, reduced to what the test needs: a mode and a world-to-box matrix each. */
export interface ActiveSections {
  modes: Mode[]
  /** Maps a world point into the box's unit cube, where "inside" is |x|, |y|, |z| <= 0.5 */
  matrices: Float32Array[]
  /** Identifies the shader these boxes need; the matrices can change without changing it */
  key: string
}

const MIN_SIZE = 1e-4

export function activeSections(sections: readonly SectionBox[]): ActiveSections {
  const enabled = sections.filter((s) => s.enabled !== false).slice(0, MAX_SECTIONS)
  const position = new Vec3()
  const rotation = new Quat()
  const size = new Vec3()
  const matrix = new Mat4()
  const matrices = enabled.map((s) => {
    position.set(s.position[0], s.position[1], s.position[2])
    rotation.setFromEulerAngles(s.rotation[0], s.rotation[1], s.rotation[2])
    // a flattened box would make the matrix singular
    size.set(Math.max(Math.abs(s.size[0]), MIN_SIZE), Math.max(Math.abs(s.size[1]), MIN_SIZE), Math.max(Math.abs(s.size[2]), MIN_SIZE))
    return new Float32Array(matrix.setTRS(position, rotation, size).invert().data)
  })
  const modes = enabled.map((s): Mode => (s.mode === 'cut' ? 'cut' : 'keep'))
  return { modes, matrices, key: modes.join(',') }
}

const uniformName = (index: number) => `uSection${index}`

/**
 * Shader source declaring `sectionKeep(worldCenter)`, the share of a splat's opacity that
 * survives the boxes (1 inside, `uSectionRest` for what they leave out), for a given list
 * of box modes. The
 * modes are baked into the code and only the matrices are uniforms, so moving a box never
 * recompiles; adding, removing or re-typing one does.
 */
export function sectionChunk(modes: readonly Mode[]): { glsl: string; wgsl: string } {
  const keeps = modes.flatMap((mode, i) => (mode === 'keep' ? [i] : []))
  const cuts = modes.flatMap((mode, i) => (mode === 'cut' ? [i] : []))
  const any = (indices: number[], call: (i: number) => string) => indices.map(call).join(' || ')

  if (modes.length === 0) {
    return {
      glsl: 'float sectionKeep(vec3 p) { return 1.0; }\n',
      wgsl: 'fn sectionKeep(p: vec3f) -> f32 { return 1.0; }\n',
    }
  }

  const glsl = `
${modes.map((_, i) => `uniform mat4 ${uniformName(i)};`).join('\n')}
bool insideSection(mat4 m, vec3 p) {
    vec3 q = abs((m * vec4(p, 1.0)).xyz);
    return max(q.x, max(q.y, q.z)) <= 0.5;
}
bool sectionCulled(vec3 p) {
    ${keeps.length ? `if (!(${any(keeps, (i) => `insideSection(${uniformName(i)}, p)`)})) return true;` : ''}
    ${cuts.length ? `if (${any(cuts, (i) => `insideSection(${uniformName(i)}, p)`)}) return true;` : ''}
    return false;
}
// how much of a splat at p is shown: all of it, or what is left to the part the boxes leave out
uniform float uSectionRest;
float sectionKeep(vec3 p) {
    return sectionCulled(p) ? uSectionRest : 1.0;
}
`
  const wgsl = `
${modes.map((_, i) => `uniform ${uniformName(i)}: mat4x4f;`).join('\n')}
fn insideSection(m: mat4x4f, p: vec3f) -> bool {
    let q = abs((m * vec4f(p, 1.0)).xyz);
    return max(q.x, max(q.y, q.z)) <= 0.5;
}
fn sectionCulled(p: vec3f) -> bool {
    ${keeps.length ? `if (!(${any(keeps, (i) => `insideSection(uniform.${uniformName(i)}, p)`)})) { return true; }` : ''}
    ${cuts.length ? `if (${any(cuts, (i) => `insideSection(uniform.${uniformName(i)}, p)`)}) { return true; }` : ''}
    return false;
}
uniform uSectionRest: f32;
fn sectionKeep(p: vec3f) -> f32 {
    if (sectionCulled(p)) {
        return uniform.uSectionRest;
    }
    return 1.0;
}
`
  return { glsl, wgsl }
}

/**
 * Upload the box matrices and how visible the left-out splats stay (0 = not drawn).
 * The caller decides when the work buffer is redrawn.
 */
export function setSectionUniforms(component: GSplatComponent, active: ActiveSections, rest: number) {
  active.matrices.forEach((matrix, i) => component.setParameter(uniformName(i), matrix))
  component.setParameter('uSectionRest', rest)
}

/**
 * The same test on the CPU, for things that must agree with what is drawn: which splats a
 * selection may touch, and which callouts still have something to point at.
 * Returns null when no box is active, so callers can skip the work entirely.
 */
export function sectionTest(sections: readonly SectionBox[]): ((x: number, y: number, z: number) => boolean) | null {
  const { modes, matrices } = activeSections(sections)
  if (modes.length === 0) return null
  const hasKeep = modes.includes('keep')
  const inside = (m: Float32Array, x: number, y: number, z: number) =>
    Math.abs(m[0] * x + m[4] * y + m[8] * z + m[12]) <= 0.5 &&
    Math.abs(m[1] * x + m[5] * y + m[9] * z + m[13]) <= 0.5 &&
    Math.abs(m[2] * x + m[6] * y + m[10] * z + m[14]) <= 0.5
  return (x, y, z) => {
    let kept = !hasKeep
    for (let i = 0; i < modes.length; i++) {
      if (!inside(matrices[i], x, y, z)) continue
      if (modes[i] === 'cut') return true
      kept = true
    }
    return !kept
  }
}
