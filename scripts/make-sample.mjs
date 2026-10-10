// Generates the built-in sample: a procedural 3D Gaussian Splat scene, written the way trained
// captures are (binary 3DGS .ply, Y pointing down).
//
//   public/samples/knot.ply        the "raw capture": the subject plus a shell of stray floater
//                                  splats and one dense blob, for the editor's cleanup tools
//   public/samples/knot-clean.ply  the subject alone, what the player demos show
//
//   node scripts/make-sample.mjs [--count 70000] [--dir public/samples]

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = resolve(root, arg('dir', 'public/samples'))
const knotCount = Number(arg('count', 70000))

// deterministic so the sample is identical on every machine
let seed = 0x9e3779b9
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const range = (a, b) => a + (b - a) * rand()

const SH_C0 = 0.28209479177387814
const TAU = Math.PI * 2

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

/** Quaternion (w, x, y, z) of the rotation whose columns are the axes x, y, z. */
function quatFromAxes(x, y, z) {
  const m00 = x[0], m10 = x[1], m20 = x[2]
  const m01 = y[0], m11 = y[1], m21 = y[2]
  const m02 = z[0], m12 = z[1], m22 = z[2]
  const tr = m00 + m11 + m22
  let w, qx, qy, qz
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2
    w = s / 4; qx = (m21 - m12) / s; qy = (m02 - m20) / s; qz = (m10 - m01) / s
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2
    w = (m21 - m12) / s; qx = s / 4; qy = (m01 + m10) / s; qz = (m02 + m20) / s
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2
    w = (m02 - m20) / s; qx = (m01 + m10) / s; qy = s / 4; qz = (m12 + m21) / s
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2
    w = (m10 - m01) / s; qx = (m02 + m20) / s; qy = (m12 + m21) / s; qz = s / 4
  }
  return [w, qx, qy, qz]
}

const randomQuat = () => {
  const q = [range(-1, 1), range(-1, 1), range(-1, 1), range(-1, 1)]
  const l = Math.hypot(...q) || 1
  return q.map((v) => v / l)
}

/** @type {{p:number[], q:number[], s:number[], c:number[], a:number, stray:boolean}[]} */
const splats = []
let stray = false
const add = (p, q, s, c, a) => splats.push({ p, q, s, c, a, stray })

// ── the torus knot ──────────────────────────────────────────────────────────
const P = 2, Q = 3, R = 1.0, r = 0.42, TUBE = 0.21
const curve = (t) => {
  const k = R + r * Math.cos(Q * t)
  return [k * Math.cos(P * t), r * Math.sin(Q * t), k * Math.sin(P * t)]
}
// iq-style cosine palette: a cool-to-warm iridescent loop
const palette = (u) => [
  0.5 + 0.5 * Math.cos(TAU * (u + 0.0)),
  0.5 + 0.5 * Math.cos(TAU * (u + 0.33)),
  0.5 + 0.5 * Math.cos(TAU * (u + 0.67)),
]
const LIGHT = norm([0.45, 0.8, 0.4])

for (let i = 0; i < knotCount; i++) {
  const t = rand() * TAU
  const v = rand() * TAU
  const c0 = curve(t)
  const tangent = norm(sub(curve(t + 1e-3), curve(t - 1e-3)))
  // a stable frame around the curve: push the reference away from the tangent
  const ref = Math.abs(tangent[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]
  const n1 = norm(cross(tangent, ref))
  const n2 = cross(tangent, n1)
  const normal = norm([
    Math.cos(v) * n1[0] + Math.sin(v) * n2[0],
    Math.cos(v) * n1[1] + Math.sin(v) * n2[1],
    Math.cos(v) * n1[2] + Math.sin(v) * n2[2],
  ])
  // ripple the tube so it reads as an organic surface rather than a clean pipe
  const radius = TUBE * (1 + 0.22 * Math.sin(9 * t + 2 * v) + 0.08 * Math.sin(23 * t - 5 * v))
  const p = [c0[0] + normal[0] * radius, c0[1] + normal[1] * radius, c0[2] + normal[2] * radius]
  const around = cross(normal, tangent)
  const q = quatFromAxes(tangent, around, normal)

  const base = palette(t / TAU + 0.12 * Math.sin(v))
  const lit = 0.3 + 0.7 * Math.max(0, dot(normal, LIGHT))
  const rim = 0.25 * Math.pow(1 - Math.abs(normal[1]), 3)
  const grain = range(-0.04, 0.04)
  const c = base.map((ch) => Math.min(1, Math.max(0, ch * lit + rim + grain)))

  const size = range(0.011, 0.022)
  add(p, q, [size, size * range(0.7, 1.3), size * 0.18], c, range(0.82, 0.99))
}

// ── a soft ground disc ──────────────────────────────────────────────────────
for (let i = 0; i < 9000; i++) {
  const rad = Math.sqrt(rand()) * 2.1
  const ang = rand() * TAU
  const fade = Math.pow(1 - rad / 2.1, 1.5)
  const shade = 0.07 + 0.12 * fade + range(-0.01, 0.01)
  const size = range(0.04, 0.07)
  add(
    [Math.cos(ang) * rad, -0.86 + range(-0.004, 0.004), Math.sin(ang) * rad],
    quatFromAxes([1, 0, 0], [0, 0, -1], [0, 1, 0]),
    [size, size, 0.004],
    [shade, shade, shade * 1.1],
    0.05 + 0.8 * fade,
  )
}

// ── floaters: the stray, half-transparent splats every real capture has ─────
stray = true
for (let i = 0; i < 1800; i++) {
  const dir = norm([range(-1, 1), range(-0.5, 1), range(-1, 1)])
  const dist = range(1.7, 2.8)
  const g = range(0.25, 0.7)
  const size = range(0.02, 0.055)
  add(
    [dir[0] * dist, dir[1] * dist * 0.8 + 0.3, dir[2] * dist],
    randomQuat(),
    [size, size * range(0.4, 1), size * range(0.2, 0.6)],
    [g, g * range(0.9, 1.05), g * range(0.9, 1.1)],
    range(0.04, 0.22),
  )
}

// ── one dense stray blob: an obvious thing to select and delete ─────────────
for (let i = 0; i < 1400; i++) {
  const d = norm([range(-1, 1), range(-1, 1), range(-1, 1)])
  const rad = Math.cbrt(rand()) * 0.26
  const size = range(0.015, 0.03)
  add(
    [1.95 + d[0] * rad, 0.9 + d[1] * rad, -0.6 + d[2] * rad],
    randomQuat(),
    [size, size, size],
    [0.95, range(0.2, 0.35), range(0.5, 0.7)],
    range(0.5, 0.9),
  )
}

// ── write ───────────────────────────────────────────────────────────────────
const props = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']

function write(name, list) {
  const header =
    ['ply', 'format binary_little_endian 1.0', 'comment generated by splat-engine scripts/make-sample.mjs', `element vertex ${list.length}`]
      .concat(props.map((p) => `property float ${p}`))
      .concat(['end_header'])
      .join('\n') + '\n'

  const body = new Float32Array(list.length * props.length)
  list.forEach(({ p, q, s, c, a }, i) => {
    const o = i * props.length
    // captures are stored Y-down; a half-turn about Z converts from the Y-up scene above
    body[o] = -p[0]
    body[o + 1] = -p[1]
    body[o + 2] = p[2]
    for (let k = 0; k < 3; k++) body[o + 3 + k] = (c[k] - 0.5) / SH_C0
    body[o + 6] = Math.log(a / (1 - a))
    for (let k = 0; k < 3; k++) body[o + 7 + k] = Math.log(s[k])
    // (0, 0, 0, 1) ⊗ q
    body[o + 10] = -q[3]
    body[o + 11] = -q[2]
    body[o + 12] = q[1]
    body[o + 13] = q[0]
  })

  const out = resolve(dir, name)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, Buffer.concat([Buffer.from(header, 'ascii'), Buffer.from(body.buffer)]))
  console.log(`wrote ${out}: ${list.length.toLocaleString()} splats, ${((header.length + body.byteLength) / 1048576).toFixed(1)} MB`)
}

write('knot.ply', splats)
write('knot-clean.ply', splats.filter((s) => !s.stray))
