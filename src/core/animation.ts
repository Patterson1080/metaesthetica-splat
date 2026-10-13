import type { Animation, Force, Keyframe, SectionBox, SectionRest, Track } from './scene'

/** Two keys closer together than this, in seconds, are the same key */
export const SAME_TIME = 1e-3

/** What a track carries: one number, or a vector (position, rotation, size...) */
export type AnimValue = number | number[]

/** What a track animates, parsed from its `target` path. */
export interface TargetRef {
  kind: 'splat' | 'camera' | 'force' | 'section' | 'rest'
  /** Which force or section box; 0 for the other kinds */
  index: number
  prop: string
}

// The properties that can carry keyframes. A force's travel time is left out on purpose:
// every splat's place along its path is derived from it, so changing it mid-flight would
// make the whole flow jump.
export const ANIMATABLE = {
  splat: ['position', 'rotation', 'scale'],
  camera: ['position', 'target', 'fov'],
  force: ['position', 'rotation', 'radius', 'strength', 'amount', 'dotSize', 'tint', 'noise', 'noiseScale', 'lift', 'pull'],
  section: ['position', 'rotation', 'size'],
  rest: ['opacity'],
} as const

export const targetOf = (kind: TargetRef['kind'], prop: string, index = 0) =>
  kind === 'force' || kind === 'section' ? `${kind}.${index}.${prop}` : `${kind}.${prop}`

export function parseTarget(target: string): TargetRef | null {
  const parts = target.split('.')
  const kind = parts[0] as TargetRef['kind']
  if (!(kind in ANIMATABLE)) return null
  const indexed = kind === 'force' || kind === 'section'
  if (parts.length !== (indexed ? 3 : 2)) return null
  const index = indexed ? Number(parts[1]) : 0
  const prop = parts[indexed ? 2 : 1]
  if (!Number.isInteger(index) || index < 0 || !(ANIMATABLE[kind] as readonly string[]).includes(prop)) return null
  return { kind, index, prop }
}

const lerp = (a: number, b: number, u: number) => a + (b - a) * u
const DEG = 180 / Math.PI
/** Signed difference between two headings, in -180..180 */
const turn = (degrees: number) => ((((degrees % 360) + 540) % 360) - 180)
const part = (key: Keyframe, component: number) => (typeof key.v === 'number' ? key.v : (key.v[component] ?? 0))

/**
 * Slope of a component at key `i`, chosen the way Blender's "auto clamped" handles are: the
 * curve runs smoothly through a key that lies between its neighbours, and levels off at one
 * that is a peak, a dip or the end of a plateau. A value therefore never swings past its
 * keys, and two equal keys in a row hold still between them.
 *
 * The first and last keys ease in and out. With `cycle` (the loop's length, for a track
 * whose last key repeats its first) they take their neighbours from across the seam
 * instead, so the loop turns over without a hitch.
 */
function slope(keys: Keyframe[], i: number, component: number, cycle: number | null): number {
  const last = keys.length - 1
  // what the value gains over one whole loop: nothing, or whole turns for a heading
  const lap = cycle === null ? 0 : part(keys[last], component) - part(keys[0], component)
  let beforeT: number
  let beforeV: number
  let afterT: number
  let afterV: number
  if (i > 0) {
    beforeT = keys[i - 1].t
    beforeV = part(keys[i - 1], component)
  } else if (cycle !== null) {
    beforeT = keys[last - 1].t - cycle
    beforeV = part(keys[last - 1], component) - lap
  } else return 0
  if (i < last) {
    afterT = keys[i + 1].t
    afterV = part(keys[i + 1], component)
  } else if (cycle !== null) {
    afterT = keys[1].t + cycle
    afterV = part(keys[1], component) + lap
  } else return 0

  const t = keys[i].t
  const v = part(keys[i], component)
  if (t - beforeT < 1e-9 || afterT - t < 1e-9) return 0
  const into = (v - beforeV) / (t - beforeT)
  const out = (afterV - v) / (afterT - t)
  // a peak, a dip, or flat on one side: level
  if (into * out <= 0) return 0
  const through = (afterV - beforeV) / (afterT - beforeT)
  // no steeper than keeps the curve between its keys
  return Math.sign(through) * Math.min(Math.abs(through), 3 * Math.min(Math.abs(into), Math.abs(out)))
}

function sampleKeys(keys: Keyframe[], t: number, cycle: number | null): AnimValue | null {
  if (keys.length === 0) return null
  if (t <= keys[0].t) return keys[0].v
  const last = keys[keys.length - 1]
  if (t >= last.t) return last.v

  let i = 0
  while (i < keys.length - 2 && keys[i + 1].t <= t) i++
  const k0 = keys[i]
  const k1 = keys[i + 1]
  const ease = k0.ease ?? 'smooth'
  if (ease === 'hold') return k0.v
  const dt = k1.t - k0.t
  const u = dt > 1e-9 ? (t - k0.t) / dt : 1

  const component = (p0: number, p1: number, c: number) => {
    if (ease === 'linear') return lerp(p0, p1, u)
    // cubic Hermite
    const u2 = u * u
    const u3 = u2 * u
    return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * dt * slope(keys, i, c, cycle) + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * dt * slope(keys, i + 1, c, cycle)
  }

  if (typeof k0.v === 'number' || typeof k1.v === 'number') {
    return component(typeof k0.v === 'number' ? k0.v : k0.v[0], typeof k1.v === 'number' ? k1.v : k1.v[0], 0)
  }
  const v1 = k1.v
  return k0.v.map((p0, c) => component(p0, v1[c] ?? p0, c))
}

/** Whether keys span one whole loop of `wrap` seconds, from 0 to its end */
const spansLoop = (keys: Keyframe[], wrap: number | undefined): wrap is number =>
  wrap !== undefined && keys.length >= 3 && Math.abs(keys[0].t) < SAME_TIME && Math.abs(keys[keys.length - 1].t - wrap) < SAME_TIME

/**
 * A track's value at time `t`. Before the first key and after the last it holds their
 * values. Between two keys the earlier one's `ease` decides: 'smooth' (the default) is a
 * cubic through the keys, 'linear' a straight line, 'hold' keeps the earlier value.
 *
 * `wrap` is the length of the animation when it loops. A track that starts at 0 and ends
 * there on the value it began with is then treated as one seamless cycle.
 */
export function sampleTrack(track: Track, t: number, wrap?: number): AnimValue | null {
  const { keys } = track
  let cycle: number | null = null
  if (spansLoop(keys, wrap)) {
    const first = keys[0].v
    const last = keys[keys.length - 1].v
    const same = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b))
    const closed = typeof first === 'number' || typeof last === 'number' ? typeof first === 'number' && typeof last === 'number' && same(first, last) : first.every((v, c) => same(v, last[c] ?? NaN))
    if (closed) cycle = wrap
  }
  return sampleKeys(keys, t, cycle)
}

const isPoint = (v: AnimValue | null): v is number[] => Array.isArray(v) && v.length >= 3

/**
 * Where the camera stands at time `t`, taken as an orbit around what it looks at.
 *
 * A camera's keys are views: a point to look at, and a place to look from. Easing the
 * place in a straight line from one key to the next would cut the corner of every orbit,
 * diving toward the subject between two views of it and passing straight through it when
 * they face each other. So each position key is read as a heading, an elevation and a
 * distance from the target at that moment, those three are eased, and the place is built
 * again around the target. An orbit keyed at a steady distance then stays at that distance;
 * a dolly or a pan (where the target moves too) still comes out as the straight move it was.
 */
function sampleOrbit(position: Track, target: Track, t: number, wrap?: number): AnimValue | null {
  const centre = (at: number) => sampleTrack(target, at, wrap)
  const keys: Keyframe[] = []
  let heading = 0
  for (const key of position.keys) {
    const c = centre(key.t)
    if (!isPoint(key.v) || !isPoint(c)) return sampleTrack(position, t, wrap)
    const dx = key.v[0] - c[0]
    const dy = key.v[1] - c[1]
    const dz = key.v[2] - c[2]
    const distance = Math.hypot(dx, dy, dz)
    // straight above or below, a place has no heading of its own: it keeps the one before
    const raw = Math.hypot(dx, dz) > 1e-6 * Math.max(distance, 1e-6) ? Math.atan2(dx, dz) * DEG : heading
    // each key is reached the short way round from the one before
    heading = keys.length === 0 ? raw : heading + turn(raw - heading)
    const elevation = distance > 1e-9 ? Math.asin(Math.min(Math.max(dy / distance, -1), 1)) * DEG : 0
    keys.push({ t: key.t, v: [heading, elevation, distance], ...(key.ease ? { ease: key.ease } : {}) })
  }
  if (keys.length === 0) return null

  // a loop that ends on the view it began with, however many turns later, is one seamless cycle
  let cycle: number | null = null
  if (spansLoop(keys, wrap)) {
    const first = keys[0].v as number[]
    const last = keys[keys.length - 1].v as number[]
    if (Math.abs(turn(last[0] - first[0])) < 1e-3 && Math.abs(last[1] - first[1]) < 1e-3 && Math.abs(last[2] - first[2]) < 1e-4 * Math.max(1, first[2])) cycle = wrap
  }
  const orbit = sampleKeys(keys, t, cycle)
  const c = centre(t)
  if (!isPoint(orbit) || !isPoint(c)) return null
  const yaw = orbit[0] / DEG
  const pitch = orbit[1] / DEG
  const flat = orbit[2] * Math.cos(pitch)
  return [c[0] + flat * Math.sin(yaw), c[1] + orbit[2] * Math.sin(pitch), c[2] + flat * Math.cos(yaw)]
}

/** The loop's length, for an animation that loops */
const wrapOf = (animation: Animation) => (animation.loop !== false ? animation.duration : undefined)

/**
 * What a target is at time `t`, the way playback will have it: null when nothing animates
 * it. This is the one place that knows a camera's position is eased as an orbit.
 */
export function sampleTarget(animation: Animation, target: string, t: number): AnimValue | null {
  const track = animation.tracks.find((candidate) => candidate.target === target)
  if (!track) return null
  const wrap = wrapOf(animation)
  if (target === 'camera.position') {
    const lookAt = animation.tracks.find((candidate) => candidate.target === 'camera.target')
    if (lookAt && lookAt.keys.length > 0) return sampleOrbit(track, lookAt, t, wrap)
  }
  return sampleTrack(track, t, wrap)
}

/** Sample every track at `t` and hand each value to `write`. */
export function evaluate(animation: Animation | undefined, t: number, write: (ref: TargetRef, value: AnimValue) => void) {
  if (!animation) return
  for (const track of animation.tracks) {
    const ref = parseTarget(track.target)
    if (!ref) continue
    const value = sampleTarget(animation, track.target, t)
    if (value !== null) write(ref, value)
  }
}

/** The objects a scene's force, section and rest tracks write into. */
export interface AnimatedScene {
  forces: Force[]
  sections: SectionBox[]
  sectionRest: SectionRest
}

const clamp01 = (n: number) => Math.min(Math.max(n, 0), 1)

/**
 * A sampled value as the scene will hold it: sizes and reaches stay positive, shares stay
 * shares. A smooth curve can overshoot its keys, so what a track says is not always what
 * the scene gets.
 */
export function constrain(ref: TargetRef, value: AnimValue): AnimValue {
  if (typeof value === 'number') {
    if (ref.kind === 'rest' || ref.prop === 'amount' || ref.prop === 'tint') return clamp01(value)
    if (ref.prop === 'radius' || ref.prop === 'dotSize' || ref.prop === 'noiseScale') return Math.max(value, 1e-4)
    return value
  }
  return ref.prop === 'size' || ref.prop === 'scale' ? value.map((v) => Math.max(v, 1e-3)) : [...value]
}

/**
 * Write a sampled value into the scene data it animates. Returns false for targets that are
 * not scene data (the splat's transform and the camera belong to the viewer) or that point
 * at a force or box that is no longer there.
 */
export function writeSceneValue(scene: AnimatedScene, ref: TargetRef, value: AnimValue): boolean {
  if (ref.kind === 'rest') {
    if (typeof value === 'number') scene.sectionRest.opacity = constrain(ref, value) as number
    return true
  }
  if (ref.kind !== 'force' && ref.kind !== 'section') return false
  const item = (ref.kind === 'force' ? scene.forces : scene.sections)[ref.index] as unknown as Record<string, AnimValue> | undefined
  if (!item) return false
  item[ref.prop] = constrain(ref, value)
  return true
}

/** The current value of a scene-data target, for writing a key from it. */
export function readSceneValue(scene: AnimatedScene, ref: TargetRef): AnimValue | null {
  if (ref.kind === 'rest') return scene.sectionRest.opacity
  if (ref.kind !== 'force' && ref.kind !== 'section') return null
  const item = (ref.kind === 'force' ? scene.forces : scene.sections)[ref.index] as unknown as Record<string, AnimValue | undefined> | undefined
  const value = item?.[ref.prop]
  if (value === undefined) return ref.prop === 'rotation' ? [0, 0, 0] : null
  return typeof value === 'number' ? value : [...value]
}


/** Set a key on a track at time `t`, replacing one already there. Keeps the keys in time order. */
export function insertKey(animation: Animation, target: string, t: number, value: AnimValue): Keyframe {
  let track = animation.tracks.find((candidate) => candidate.target === target)
  if (!track) {
    track = { target, keys: [] }
    animation.tracks.push(track)
  }
  const v = typeof value === 'number' ? value : [...value]
  const existing = track.keys.find((key) => Math.abs(key.t - t) < SAME_TIME)
  if (existing) {
    existing.v = v
    return existing
  }
  const key: Keyframe = { t, v }
  track.keys.push(key)
  track.keys.sort((a, b) => a.t - b.t)
  return key
}

/**
 * A force or section box was removed: drop its tracks and renumber the ones after it, so
 * every remaining track still points at the object it was made for.
 */
export function dropTracksFor(animation: Animation, kind: 'force' | 'section', removed: number) {
  animation.tracks = animation.tracks.flatMap((track) => {
    const ref = parseTarget(track.target)
    if (!ref || ref.kind !== kind) return [track]
    if (ref.index === removed) return []
    return [ref.index > removed ? { ...track, target: targetOf(kind, ref.prop, ref.index - 1) } : track]
  })
}
