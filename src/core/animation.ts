import type { Animation, Force, Keyframe, SectionBox, SectionRest, Track } from './scene'

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

/** Slope of a component at key `i`: the Catmull-Rom tangent, which carries motion through a key instead of stopping on it. */
function slope(keys: Keyframe[], i: number, component: number): number {
  const at = (k: number) => {
    const v = keys[k].v
    return typeof v === 'number' ? v : (v[component] ?? 0)
  }
  const a = Math.max(i - 1, 0)
  const b = Math.min(i + 1, keys.length - 1)
  const dt = keys[b].t - keys[a].t
  return dt > 1e-9 ? (at(b) - at(a)) / dt : 0
}

/**
 * A track's value at time `t`. Before the first key and after the last it holds their
 * values. Between two keys the earlier one's `ease` decides: 'smooth' (the default) is a
 * cubic through the keys, 'linear' a straight line, 'hold' keeps the earlier value.
 */
export function sampleTrack(track: Track, t: number): AnimValue | null {
  const { keys } = track
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
    return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * dt * slope(keys, i, c) + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * dt * slope(keys, i + 1, c)
  }

  if (typeof k0.v === 'number' || typeof k1.v === 'number') {
    return component(typeof k0.v === 'number' ? k0.v : k0.v[0], typeof k1.v === 'number' ? k1.v : k1.v[0], 0)
  }
  const v1 = k1.v
  return k0.v.map((p0, c) => component(p0, v1[c] ?? p0, c))
}

/** Sample every track at `t` and hand each value to `write`. */
export function evaluate(animation: Animation | undefined, t: number, write: (ref: TargetRef, value: AnimValue) => void) {
  if (!animation) return
  for (const track of animation.tracks) {
    const ref = parseTarget(track.target)
    if (!ref) continue
    const value = sampleTrack(track, t)
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
 * Write a sampled value into the scene data it animates. Returns false for targets that are
 * not scene data (the splat's transform and the camera belong to the viewer) or that point
 * at a force or box that is no longer there.
 */
export function writeSceneValue(scene: AnimatedScene, ref: TargetRef, value: AnimValue): boolean {
  if (ref.kind === 'rest') {
    if (typeof value === 'number') scene.sectionRest.opacity = clamp01(value)
    return true
  }
  if (ref.kind !== 'force' && ref.kind !== 'section') return false
  const item = (ref.kind === 'force' ? scene.forces : scene.sections)[ref.index] as unknown as Record<string, AnimValue> | undefined
  if (!item) return false
  if (typeof value === 'number') {
    // sizes and reaches must stay positive, shares stay shares
    const positive = ref.prop === 'radius' || ref.prop === 'dotSize' || ref.prop === 'noiseScale'
    const share = ref.prop === 'amount' || ref.prop === 'tint'
    item[ref.prop] = share ? clamp01(value) : positive ? Math.max(value, 1e-4) : value
  } else {
    item[ref.prop] = ref.prop === 'size' ? value.map((v) => Math.max(v, 1e-3)) : [...value]
  }
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

const SAME_TIME = 1e-3

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
