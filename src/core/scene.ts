/**
 * The scene description shared by the editor (which writes it) and the player (which reads
 * it). It is plain JSON so it can live next to the splat file on any static host.
 */

export type Vec3Tuple = [number, number, number]

/** Graphics API to prefer. WebGPU falls back to WebGL 2 where it is unavailable. */
export type DeviceType = 'webgl2' | 'webgpu'

export interface SplatSource {
  /** URL of the splat file (.ply, .compressed.ply, .sog, meta.json, lod-meta.json), relative to the scene file */
  src: string
  /** File name to pick the parser by when the URL does not end in one (blob: or signed URLs) */
  filename?: string
  name?: string
  position?: Vec3Tuple
  /** Euler angles in degrees */
  rotation?: Vec3Tuple
  scale?: Vec3Tuple
}

export interface CameraPose {
  name?: string
  position: Vec3Tuple
  target: Vec3Tuple
}

export interface ControlLimits {
  /** Closest the camera may get to the orbit target */
  minDistance?: number
  maxDistance?: number
  /** Degrees; negative looks down on the scene, positive looks up from below */
  minPitch?: number
  maxPitch?: number
  /** Let viewers move the orbit target */
  pan?: boolean
  /** Degrees per second around the target while idle; 0 = off */
  autoRotate?: number
}

/**
 * A box that culls splats without deleting them. What is drawn is everything inside any
 * 'keep' box (or everything, when there are none) minus everything inside any 'cut' box.
 */
export interface SectionBox {
  name?: string
  /** Center of the box, in world space */
  position: Vec3Tuple
  /** Euler angles in degrees */
  rotation: Vec3Tuple
  /** Full extent along each of the box's own axes */
  size: Vec3Tuple
  /** 'keep' (default) shows only what is inside; 'cut' removes what is inside */
  mode?: 'keep' | 'cut'
  /** false leaves the box in the file but switches it off */
  enabled?: boolean
}

/** A text callout pinned to a point on the splat. */
export interface Annotation {
  title?: string
  /** Body text; line breaks are kept */
  text?: string
  /** The point the callout is pinned to, in world space */
  position: Vec3Tuple
  /** Where the text sits relative to that point on screen, in CSS pixels (x right, y down) */
  offset?: [number, number]
}

export type ForceType = 'swirl' | 'wind' | 'attract' | 'turbulence'

/**
 * A force field that sets the splat's own points flowing. Splats within its reach leave
 * their place, travel along the force's motion, fade out and start again from home. No
 * points are added: by default each carried splat keeps its shape and color. Optionally
 * only a share is carried (the rest hold the form), and carried splats can be drawn as
 * tinted dots.
 */
export interface Force {
  name?: string
  type: ForceType
  /** Center of the force's reach, in world space */
  position: Vec3Tuple
  /** Euler angles in degrees. The force's own +Y is the swirl axis or the wind direction. */
  rotation?: Vec3Tuple
  /** How far the force reaches; its hold fades to nothing at this distance */
  radius: number
  /** Speed of the motion: swirl in degrees/s, wind and turbulence in units/s, attract in 1/s (negative repels) */
  strength: number
  /** Share (0..1) of the splats in reach that are carried; default 1, all of them */
  amount?: number
  /** Seconds a loose splat travels before it fades and starts again from home */
  cycle?: number
  /**
   * How the splats this force carries are drawn: 'splats' (default) keeps each one's own
   * shape, 'points' draws them as plain round points of one size.
   */
  render?: 'splats' | 'points'
  /** Size of those points, in world units. Only used when `render` is 'points'. */
  dotSize?: number
  /** Color carried splats take on (hex) ... */
  color?: string
  /** ... and how far it replaces their own color, 0..1; default 0 keeps their own color */
  tint?: number
  /** Wandering laid over the motion, in units/s */
  noise?: number
  /** Size of that wandering's eddies, in world units */
  noiseScale?: number
  /** Swirl only: drift along the axis, in units/s */
  lift?: number
  /** Swirl only: drift toward the axis, in units/s (negative flings outward) */
  pull?: number
  enabled?: boolean
}

export interface SplatScene {
  version: 1
  name?: string
  splats: SplatSource[]
  camera?: {
    /** Vertical field of view in degrees */
    fov?: number
    /** Where the camera starts and what "reset" returns to */
    initial?: CameraPose
  }
  /** Named viewpoints the player can step through */
  poses?: CameraPose[]
  controls?: ControlLimits
  /** CSS hex color, or null for a transparent canvas that shows the page behind it */
  background?: string | null
  /** Image shown until the splat has loaded, relative to the scene file */
  poster?: string
  /** Culling volumes; at most MAX_SECTIONS are applied */
  sections?: SectionBox[]
  /** Text callouts pinned to points on the splat */
  annotations?: Annotation[]
  /** Force fields that set splats flowing; at most MAX_FORCES are applied */
  forces?: Force[]
}

/** Section boxes are evaluated per splat on the GPU, one uniform each */
export const MAX_SECTIONS = 8
export const DEFAULT_ANNOTATION_OFFSET: [number, number] = [56, -44]
/** Each force is a handful of uniforms and a few lines of shader evaluated for every splat */
export const MAX_FORCES = 4
export const FORCE_TYPES: readonly ForceType[] = ['swirl', 'wind', 'attract', 'turbulence']
// by default a force carries the splat's own points, as they are: every splat in reach, in its own shape and color
export const FORCE_DEFAULTS = { amount: 1, cycle: 6, dotSize: 0.012, color: '#7fd4ff', tint: 0, noise: 0.1, noiseScale: 1, lift: 0.1, pull: 0 }

/** Whether a force draws what it carries as points. Files from before `render` existed said so with a size above zero. */
export const drawsPoints = (force: Force) => force.render === 'points' || (force.render === undefined && (force.dotSize ?? 0) > 0)

/** Captures are stored Y-down; a half-turn about Z stands them upright in a Y-up world. */
export const DEFAULT_ROTATION: Vec3Tuple = [0, 0, 180]
export const DEFAULT_FOV = 60
export const DEFAULT_BACKGROUND = '#000000'

export const SPLAT_EXTENSIONS = ['.ply', '.sog', '.json']

export const isSplatFile = (name: string) => {
  const lower = name.toLowerCase().split(/[?#]/)[0]
  return SPLAT_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

const isVec3 = (v: unknown): v is Vec3Tuple =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n))

const isPose = (v: unknown): v is CameraPose =>
  typeof v === 'object' && v !== null && isVec3((v as CameraPose).position) && isVec3((v as CameraPose).target)

const text = (v: unknown) => (typeof v === 'string' ? v : undefined)

function parseSection(v: unknown): SectionBox | null {
  if (typeof v !== 'object' || v === null) return null
  const s = v as SectionBox
  if (!isVec3(s.position) || !isVec3(s.size)) return null
  return {
    name: text(s.name),
    position: s.position,
    rotation: isVec3(s.rotation) ? s.rotation : [0, 0, 0],
    size: s.size,
    mode: s.mode === 'cut' ? 'cut' : 'keep',
    enabled: s.enabled !== false,
  }
}

function parseAnnotation(v: unknown): Annotation | null {
  if (typeof v !== 'object' || v === null) return null
  const a = v as Annotation
  if (!isVec3(a.position)) return null
  const offset = a.offset
  const validOffset = Array.isArray(offset) && offset.length === 2 && offset.every((n) => typeof n === 'number' && Number.isFinite(n))
  return { title: text(a.title), text: text(a.text), position: a.position, offset: validOffset ? [offset[0], offset[1]] : undefined }
}

function parseForce(v: unknown): Force | null {
  if (typeof v !== 'object' || v === null) return null
  const f = v as Force
  const num = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : undefined)
  const radius = num(f.radius)
  const strength = num(f.strength)
  if (!isVec3(f.position) || !FORCE_TYPES.includes(f.type) || radius === undefined || strength === undefined) return null
  return {
    name: text(f.name),
    type: f.type,
    position: f.position,
    rotation: isVec3(f.rotation) ? f.rotation : [0, 0, 0],
    radius: Math.max(radius, 0),
    strength,
    amount: num(f.amount),
    cycle: num(f.cycle),
    render: drawsPoints(f) ? 'points' : 'splats',
    dotSize: num(f.dotSize),
    // only a plain hex color: scene files are untrusted input
    color: typeof f.color === 'string' && /^#[0-9a-f]{6}$/i.test(f.color) ? f.color : undefined,
    tint: num(f.tint),
    noise: num(f.noise),
    noiseScale: num(f.noiseScale),
    lift: num(f.lift),
    pull: num(f.pull),
    enabled: f.enabled !== false,
  }
}

const parseList = <T>(v: unknown, parse: (item: unknown) => T | null): T[] =>
  Array.isArray(v) ? v.map(parse).filter((item): item is T => item !== null) : []

/** Resolve a path from a scene file against the URL that scene was loaded from. */
export const resolveUrl = (path: string, base?: string) => {
  if (!base || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(path)) return path
  return new URL(path, new URL(base, document.baseURI)).href
}

/**
 * Validate untrusted JSON into a scene. Throws with a readable message on anything the
 * player could not render; unknown fields are dropped.
 */
export function parseScene(json: unknown, baseUrl?: string): SplatScene {
  if (typeof json !== 'object' || json === null) throw new Error('Scene file is not a JSON object')
  const raw = json as Record<string, unknown>
  if (raw.version !== 1) throw new Error(`Unsupported scene version: ${String(raw.version)}`)
  if (!Array.isArray(raw.splats) || raw.splats.length === 0) throw new Error('Scene has no splats')

  const splats = raw.splats.map((s, i): SplatSource => {
    if (typeof s !== 'object' || s === null || typeof (s as SplatSource).src !== 'string') {
      throw new Error(`Splat ${i} has no "src"`)
    }
    const { src, filename, name, position, rotation, scale } = s as SplatSource
    return {
      src: resolveUrl(src, baseUrl),
      filename: typeof filename === 'string' ? filename : undefined,
      name: typeof name === 'string' ? name : undefined,
      position: isVec3(position) ? position : undefined,
      rotation: isVec3(rotation) ? rotation : undefined,
      scale: isVec3(scale) ? scale : undefined,
    }
  })

  const camera = (raw.camera ?? {}) as NonNullable<SplatScene['camera']>
  const controls = (raw.controls ?? {}) as ControlLimits
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

  return {
    version: 1,
    name: typeof raw.name === 'string' ? raw.name : undefined,
    splats,
    camera: {
      fov: num(camera.fov),
      initial: isPose(camera.initial) ? camera.initial : undefined,
    },
    poses: Array.isArray(raw.poses) ? raw.poses.filter(isPose) : [],
    controls: {
      minDistance: num(controls.minDistance),
      maxDistance: num(controls.maxDistance),
      minPitch: num(controls.minPitch),
      maxPitch: num(controls.maxPitch),
      pan: typeof controls.pan === 'boolean' ? controls.pan : undefined,
      autoRotate: num(controls.autoRotate),
    },
    background: raw.background === null ? null : typeof raw.background === 'string' ? raw.background : undefined,
    poster: typeof raw.poster === 'string' ? resolveUrl(raw.poster, baseUrl) : undefined,
    sections: parseList(raw.sections, parseSection),
    annotations: parseList(raw.annotations, parseAnnotation),
    forces: parseList(raw.forces, parseForce),
  }
}

/** A scene for a bare splat URL with every setting left at its default. */
export const sceneFromSrc = (src: string): SplatScene => ({ version: 1, splats: [{ src }] })

export async function fetchScene(url: string, signal?: AbortSignal): Promise<SplatScene> {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`Could not load scene (${response.status} ${response.statusText})`)
  return parseScene(await response.json(), response.url || url)
}
