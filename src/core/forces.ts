import { Quat, Vec3, type GSplatComponent } from 'playcanvas'
import { FORCE_DEFAULTS, MAX_FORCES, type Force, type ForceType } from './scene'

/** The enabled forces, reduced to what the shader needs. */
export interface ActiveForces {
  types: ForceType[]
  /** Five vec4 uniforms per force: see `uniformsOf` */
  uniforms: Float32Array[][]
  /** Identifies the shader these forces need; their parameters can change without changing it */
  key: string
}

const UNIFORMS = ['A', 'B', 'C', 'D', 'E'] as const
const uniformName = (letter: string, index: number) => `uForce${letter}${index}`

const hexToRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

function uniformsOf(force: Force): Float32Array[] {
  const d = FORCE_DEFAULTS
  const [rx, ry, rz] = force.rotation ?? [0, 0, 0]
  const axis = new Quat().setFromEulerAngles(rx, ry, rz).transformVector(Vec3.UP, new Vec3()).normalize()
  const [r, g, b] = hexToRgb(force.color ?? d.color)
  const cycle = Math.max(force.cycle ?? d.cycle, 0.1)
  const noiseScale = Math.max(force.noiseScale ?? d.noiseScale, 1e-3)
  return [
    // A: where it is and how far it reaches
    new Float32Array([force.position[0], force.position[1], force.position[2], Math.max(force.radius, 1e-4)]),
    // B: which way it points and how hard it drives
    new Float32Array([axis.x, axis.y, axis.z, force.strength]),
    // C: share set loose, life cycles per second, dot radius, wander speed
    new Float32Array([Math.min(Math.max(force.amount ?? d.amount, 0), 1), 1 / cycle, Math.max(force.dotSize ?? d.dotSize, 0) * 0.5, force.noise ?? d.noise]),
    // D: tint
    new Float32Array([r, g, b, Math.min(Math.max(force.tint ?? d.tint, 0), 1)]),
    // E: swirl lift and pull, wander frequency
    new Float32Array([force.lift ?? d.lift, force.pull ?? d.pull, (Math.PI * 2) / noiseScale, 0]),
  ]
}

export function activeForces(forces: readonly Force[]): ActiveForces {
  const enabled = forces.filter((f) => f.enabled !== false && f.radius > 0).slice(0, MAX_FORCES)
  const types = enabled.map((f) => f.type)
  return { types, uniforms: enabled.map(uniformsOf), key: types.join(',') }
}

// How a loose splat moves, as a function of how long ago it left home. `p` starts as the
// splat's position relative to the force's center and ends as where it has got to. These are
// closed-form paths, not a simulation: there is no per-splat state to keep, so the motion is
// the same on every device and can be scrubbed to any time.
const motion: Record<ForceType, { glsl: string; wgsl: string }> = {
  swirl: {
    glsl: `
    float along = dot(p, axis);
    vec3 radial = p - axis * along;
    float r = max(length(radial), 0.00001);
    // the core turns faster than the rim, which is what draws the arms of a vortex
    float angle = radians(strength) * age * (0.3 + 0.7 * reach);
    radial = radial * cos(angle) + cross(axis, radial) * sin(angle);
    radial *= max(r - E.y * age, 0.0) / r;
    p = radial + axis * (along + E.x * age);`,
    wgsl: `
    let along = dot(p, axis);
    var radial = p - axis * along;
    let r = max(length(radial), 0.00001);
    let angle = radians(strength) * age * (0.3 + 0.7 * reach);
    radial = radial * cos(angle) + cross(axis, radial) * sin(angle);
    radial *= max(r - E.y * age, 0.0) / r;
    p = radial + axis * (along + E.x * age);`,
  },
  wind: {
    glsl: `
    p += axis * (strength * age);`,
    wgsl: `
    p += axis * (strength * age);`,
  },
  attract: {
    glsl: `
    p *= exp(-strength * age);`,
    wgsl: `
    p *= exp(-strength * age);`,
  },
  turbulence: {
    glsl: `
    float drift = uFlowTime * 0.35;
    vec3 v = flowEddy(home * E.z, drift);
    vec3 mid = home + v * (strength * age * 0.5);
    v = 0.5 * (v + flowEddy(mid * E.z, drift));
    p += v * (strength * age);`,
    wgsl: `
    let drift = uniform.uFlowTime * 0.35;
    var v = flowEddy(home * E.z, drift);
    let mid = home + v * (strength * age * 0.5);
    v = 0.5 * (v + flowEddy(mid * E.z, drift));
    p += v * (strength * age);`,
  },
}

/**
 * Shader source declaring `applyForces(center)` for a given list of force types, plus the
 * values it leaves behind for the scale and color hooks: `flowLoose` (was this splat set
 * loose), `flowFade`, `flowDot` and `flowTint`.
 */
export function forceChunk(types: readonly ForceType[]): { glsl: string; wgsl: string } {
  if (types.length === 0) {
    return {
      glsl: `
float flowLoose = 0.0;
float flowFade = 1.0;
float flowDot = 0.0;
vec4 flowTint = vec4(0.0);
void applyForces(inout vec3 center) {
}
`,
      wgsl: `
var<private> flowLoose: f32 = 0.0;
var<private> flowFade: f32 = 1.0;
var<private> flowDot: f32 = 0.0;
var<private> flowTint: vec4f = vec4f(0.0);
fn applyForces(center: ptr<function, vec3f>) {
}
`,
    }
  }

  const indices = types.map((_, i) => i)
  const glsl = `
uniform float uFlowTime;
${indices.map((i) => UNIFORMS.map((u) => `uniform vec4 ${uniformName(u, i)};`).join('\n')).join('\n')}

// what modifySplatCenter learned about this splat, for the hooks that run after it
float flowLoose = 0.0;
float flowFade = 1.0;
float flowDot = 0.0;
vec4 flowTint = vec4(0.0);

// a different, effectively random number for every splat, from where it lives
float flowHash(vec3 p, float seed) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7)) + seed) * 43758.5453);
}

// a steady, divergence-free tangle of currents (an ABC flow): cheap, and it never bunches
// the splats up or tears holes the way plain noise does
vec3 flowEddy(vec3 p, float t) {
    return 0.5 * vec3(
        sin(p.z + t) + cos(p.y - t * 0.7),
        sin(p.x + t * 0.8) + cos(p.z + t * 0.6),
        sin(p.y - t * 0.9) + cos(p.x + t)
    );
}
${types
  .map(
    (type, i) => `
void flowForce${i}(vec3 home, inout vec3 offset) {
    vec4 A = ${uniformName('A', i)};
    vec4 B = ${uniformName('B', i)};
    vec4 C = ${uniformName('C', i)};
    vec4 E = ${uniformName('E', i)};
    vec3 rel = home - A.xyz;
    // 1 at the center, fading to 0 at the edge of the force's reach
    float reach = 1.0 - smoothstep(0.0, A.w, length(rel));
    float pick = flowHash(home, ${(i * 1.7 + 0.3).toFixed(2)});
    // fewer splats are set loose toward the edge, so the current thins out instead of ending
    if (pick >= C.x * reach) return;
    // each splat keeps its own clock, so they leave home in a steady stream, not in waves
    float life = fract(uFlowTime * C.y + flowHash(home, ${(i * 2.3 + 5.1).toFixed(2)}));
    float age = life / C.y;
    vec3 axis = B.xyz;
    float strength = B.w;
    vec3 p = rel;
${motion[type].glsl}
    p += flowEddy((A.xyz + p) * E.z + pick * 6.2831, uFlowTime * 0.35) * (C.w * age);
    offset += p - rel;
    // fade in at home and out at the end of the path, which hides the jump back
    flowFade = min(flowFade, smoothstep(0.0, 0.1, life) * (1.0 - smoothstep(0.72, 1.0, life)));
    flowLoose = 1.0;
    flowDot = C.z;
    flowTint = ${uniformName('D', i)};
}`,
  )
  .join('\n')}

void applyForces(inout vec3 center) {
    vec3 home = center;
    vec3 offset = vec3(0.0);
${indices.map((i) => `    flowForce${i}(home, offset);`).join('\n')}
    center = home + offset;
}
`

  const wgsl = `
uniform uFlowTime: f32;
${indices.map((i) => UNIFORMS.map((u) => `uniform ${uniformName(u, i)}: vec4f;`).join('\n')).join('\n')}

var<private> flowLoose: f32 = 0.0;
var<private> flowFade: f32 = 1.0;
var<private> flowDot: f32 = 0.0;
var<private> flowTint: vec4f = vec4f(0.0);

fn flowHash(p: vec3f, seed: f32) -> f32 {
    return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7)) + seed) * 43758.5453);
}

fn flowEddy(p: vec3f, t: f32) -> vec3f {
    return 0.5 * vec3f(
        sin(p.z + t) + cos(p.y - t * 0.7),
        sin(p.x + t * 0.8) + cos(p.z + t * 0.6),
        sin(p.y - t * 0.9) + cos(p.x + t)
    );
}
${types
  .map(
    (type, i) => `
fn flowForce${i}(home: vec3f, offset: ptr<function, vec3f>) {
    let A = uniform.${uniformName('A', i)};
    let B = uniform.${uniformName('B', i)};
    let C = uniform.${uniformName('C', i)};
    let E = uniform.${uniformName('E', i)};
    let rel = home - A.xyz;
    let reach = 1.0 - smoothstep(0.0, A.w, length(rel));
    let pick = flowHash(home, ${(i * 1.7 + 0.3).toFixed(2)});
    if (pick >= C.x * reach) {
        return;
    }
    let life = fract(uniform.uFlowTime * C.y + flowHash(home, ${(i * 2.3 + 5.1).toFixed(2)}));
    let age = life / C.y;
    let axis = B.xyz;
    let strength = B.w;
    var p = rel;
${motion[type].wgsl}
    p += flowEddy((A.xyz + p) * E.z + pick * 6.2831, uniform.uFlowTime * 0.35) * (C.w * age);
    *offset += p - rel;
    flowFade = min(flowFade, smoothstep(0.0, 0.1, life) * (1.0 - smoothstep(0.72, 1.0, life)));
    flowLoose = 1.0;
    flowDot = C.z;
    flowTint = uniform.${uniformName('D', i)};
}`,
  )
  .join('\n')}

fn applyForces(center: ptr<function, vec3f>) {
    let home = *center;
    var offset = vec3f(0.0);
${indices.map((i) => `    flowForce${i}(home, &offset);`).join('\n')}
    *center = home + offset;
}
`
  return { glsl, wgsl }
}

export function setForceUniforms(component: GSplatComponent, active: ActiveForces) {
  active.uniforms.forEach((set, i) => set.forEach((value, u) => component.setParameter(uniformName(UNIFORMS[u], i), value)))
}

/** The farthest any force can carry a splat from home, for widening the splat's culling bounds. */
export function maxDisplacement(forces: readonly Force[]): number {
  const d = FORCE_DEFAULTS
  let reach = 0
  for (const f of forces) {
    if (f.enabled === false) continue
    const cycle = f.cycle ?? d.cycle
    const wander = Math.abs(f.noise ?? d.noise) * cycle
    const travel =
      f.type === 'swirl' ? f.radius * 2 + (Math.abs(f.lift ?? d.lift) + Math.abs(Math.min(f.pull ?? d.pull, 0))) * cycle
      : f.type === 'attract' ? (f.strength >= 0 ? f.radius : f.radius * Math.exp(Math.min(-f.strength * cycle, 6)))
      : Math.abs(f.strength) * cycle
    reach = Math.max(reach, travel + wander)
  }
  return reach
}
