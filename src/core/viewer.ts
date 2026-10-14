import {
  AppBase,
  AppOptions,
  Asset,
  BoundingBox,
  CameraComponentSystem,
  Color,
  Entity,
  FILLMODE_NONE,
  GSplatComponentSystem,
  GSplatHandler,
  RESOLUTION_AUTO,
  RESOLUTION_FIXED,
  TextureHandler,
  Vec3,
  createGraphicsDevice,
  type ComponentSystem,
  type GSplatResourceBase,
  type GraphicsDevice,
  type ResourceHandler,
} from 'playcanvas'
import { Emitter } from './events'
import { OrbitControls } from './orbit-controls'
import { DEFAULT_FOV, DEFAULT_ROTATION, type DeviceType, type SplatSource, type Vec3Tuple } from './scene'

export type { DeviceType }

export interface ViewerOptions {
  /** Graphics API to prefer; WebGPU falls back to WebGL 2 where it is missing. Default 'webgl2'. */
  device?: DeviceType
  /** Upper bound on devicePixelRatio. Splats are fill-rate bound, so 2 is plenty. Default 2. */
  maxPixelRatio?: number
  /** Start with a canvas that can show the page behind it */
  transparent?: boolean
  /** Extra engine systems (the editor adds the render system for its gizmos) */
  componentSystems?: (typeof ComponentSystem)[]
  resourceHandlers?: (typeof ResourceHandler)[]
}

/** Where a splat comes from: a URL, or a local file the user picked. */
export type SplatInput = { url: string; filename?: string } | { file: File }

export interface LoadedSplat {
  entity: Entity
  asset: Asset
  resource: GSplatResourceBase
  /** File name, used to pick the parser and to label the splat */
  filename: string
  /** The URL the scene should reference; null for a local file that has no URL yet */
  src: string | null
}

type ViewerEvents = {
  /** Fraction 0..1 of the splat currently downloading; -1 when the size is unknown */
  progress: [fraction: number]
  /** Every engine update, before rendering */
  update: [dt: number]
}

const filenameOf = (url: string) => {
  try {
    return decodeURIComponent(new URL(url, document.baseURI).pathname.split('/').pop() || 'splat.ply')
  } catch {
    return 'splat.ply'
  }
}

/**
 * A thin layer over the PlayCanvas engine: one canvas, one camera with orbit controls, and
 * any number of Gaussian splats. It renders on demand, so a still view costs nothing.
 * Both the player and the editor are built on it.
 */
export class SplatViewer {
  readonly app: AppBase
  readonly device: GraphicsDevice
  readonly canvas: HTMLCanvasElement
  readonly camera: Entity
  readonly controls: OrbitControls
  readonly events = new Emitter<ViewerEvents>()
  readonly splats: LoadedSplat[] = []

  private readonly resizeObserver: ResizeObserver
  private pendingFrames = 0
  private framePending = false
  private offlineRatio: number | null = null
  /** The lens as the scene has it; the camera's own may be wider, to fit a frame (see setFrameAspect) */
  private lens = DEFAULT_FOV
  private frameAspect: number | null = null
  private paused = false
  private destroyed = false
  private objectUrls = new Map<Asset, string>()

  static async create(canvas: HTMLCanvasElement, options: ViewerOptions = {}): Promise<SplatViewer> {
    const device = await createGraphicsDevice(canvas, {
      deviceTypes: options.device === 'webgpu' ? ['webgpu', 'webgl2'] : ['webgl2'],
      // splats are alpha-blended quads; MSAA only costs fill rate
      antialias: false,
      alpha: true,
      powerPreference: 'high-performance',
    })
    return new SplatViewer(canvas, device, options)
  }

  private constructor(canvas: HTMLCanvasElement, device: GraphicsDevice, options: ViewerOptions) {
    this.canvas = canvas
    this.device = device
    // a cap, not a value: the engine takes min(cap, devicePixelRatio) at every resize
    device.maxPixelRatio = options.maxPixelRatio ?? 2

    // only the systems a splat scene needs, so the engine tree-shakes to a fraction of its size
    const appOptions = new AppOptions()
    appOptions.graphicsDevice = device
    appOptions.componentSystems = [CameraComponentSystem, GSplatComponentSystem, ...(options.componentSystems ?? [])]
    // the texture handler is not optional: .sog files are bundles of WebP images
    appOptions.resourceHandlers = [GSplatHandler, TextureHandler, ...(options.resourceHandlers ?? [])]

    const app = new AppBase(canvas)
    app.init(appOptions)
    // the host element owns the canvas size; the engine only tracks it
    app.setCanvasFillMode(FILLMODE_NONE)
    app.setCanvasResolution(RESOLUTION_AUTO)
    app.autoRender = false
    this.app = app

    // Entities default to the engine's global "current application", which is whichever app
    // ticked last. With several viewers on a page that is not necessarily this one, so say so.
    this.camera = new Entity('camera', app)
    this.camera.addComponent('camera', {
      fov: DEFAULT_FOV,
      nearClip: 0.01,
      farClip: 1000,
      clearColor: options.transparent ? new Color(0, 0, 0, 0) : new Color(0, 0, 0, 1),
    })
    app.root.addChild(this.camera)

    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.snap()

    app.on('update', (dt: number) => {
      this.events.emit('update', dt)
      if (this.controls.update(dt)) this.requestRender()
      if (this.pendingFrames > 0) {
        this.pendingFrames--
        app.renderNextFrame = true
      }
    })
    // the sorter and the LOD streamer finish work between frames and ask for a redraw
    app.systems.gsplat?.on('frame:request', () => this.requestRender())

    this.resizeObserver = new ResizeObserver(() => {
      app.updateCanvasSize()
      this.applyFov()
      if (this.framePending && canvas.clientWidth > 0 && canvas.clientHeight > 0) this.frameScene()
      this.requestRender()
    })
    this.resizeObserver.observe(canvas)

    app.start()
    this.requestRender()
  }

  get isWebGPU() {
    return this.device.isWebGPU
  }

  // ── rendering ────────────────────────────────────────────────────────────

  /** Draw the next `frames` frames. Anything that changes the picture must call this. */
  requestRender(frames = 1) {
    this.pendingFrames = Math.max(this.pendingFrames, frames)
  }

  /** Stop the frame loop entirely (offscreen embeds); `resume` restarts it. */
  pause() {
    if (this.paused || this.destroyed) return
    this.paused = true
    if (this.app.frameRequestId) {
      cancelAnimationFrame(this.app.frameRequestId)
      this.app.frameRequestId = null as unknown as number
    }
  }

  resume() {
    if (!this.paused || this.destroyed) return
    this.paused = false
    this.app.requestAnimationFrame()
    this.requestRender(2)
  }

  /**
   * Offline rendering (video export): take the canvas off the display's clock and give it
   * an exact pixel size. Frames are then advanced one at a time with `stepFrame`.
   */
  beginOffline(width: number, height: number) {
    if (this.offlineRatio !== null) return
    this.pause()
    this.offlineRatio = this.device.maxPixelRatio
    // the size asked for is the size in pixels, whatever the display's density
    this.device.maxPixelRatio = 1
    this.app.setCanvasResolution(RESOLUTION_FIXED, width, height)
    // the canvas now is the picture, so the lens is the scene's own
    this.applyFov()
  }

  endOffline() {
    if (this.offlineRatio === null) return
    this.device.maxPixelRatio = this.offlineRatio
    this.offlineRatio = null
    this.app.setCanvasResolution(RESOLUTION_AUTO)
    this.applyFov()
    this.resume()
  }

  /**
   * Advance the engine to `timestamp` (milliseconds) and draw. On the CPU-sorted renderer the
   * depth order for a new camera position comes back from a worker a moment later, so this
   * waits for it and draws once more, without advancing time. The canvas holds the finished
   * frame when this resolves, and only until the browser next paints: read it straight away.
   */
  async stepFrame(timestamp: number) {
    this.tickOnce(timestamp)
    // a second pass covers a sort that was already under way when this frame asked for its own
    for (let pass = 0; pass < 3 && !this.sortState().settled; pass++) {
      const deadline = performance.now() + SORT_TIMEOUT
      while (this.sortState().inFlight && performance.now() < deadline) await nextTask()
      this.tickOnce(timestamp)
    }
  }

  private tickOnce(timestamp: number) {
    this.requestRender()
    this.app.tick(timestamp)
    // the tick queued the next display frame; offline, the caller decides when that is
    if (this.app.frameRequestId) {
      cancelAnimationFrame(this.app.frameRequestId)
      this.app.frameRequestId = null as unknown as number
    }
  }

  /** Where the splat depth sorts stand: still with the worker, or back and applied. */
  private sortState(): { inFlight: boolean; settled: boolean } {
    // engine internals, read defensively: if they move, frames are simply not waited for
    type Sorter = { jobsInFlight?: number; pendingSorted?: unknown }
    type LayerData = { gsplatManager?: { cpuSorter?: Sorter | null } | null }
    type Director = { camerasMap?: Map<unknown, { layersMap?: Map<unknown, LayerData> }> }
    const director = (this.app.renderer as unknown as { gsplatDirector?: Director }).gsplatDirector
    let inFlight = false
    let pending = false
    director?.camerasMap?.forEach((cameraData) => {
      cameraData.layersMap?.forEach((layerData) => {
        const sorter = layerData.gsplatManager?.cpuSorter
        if (!sorter) return
        if (sorter.pendingSorted) pending = true
        else if ((sorter.jobsInFlight ?? 0) > 0) inFlight = true
      })
    })
    return { inFlight, settled: !inFlight && !pending }
  }

  /** CSS color for an opaque background, or null for a transparent canvas. */
  setBackground(color: string | null) {
    const camera = this.camera.camera!
    if (color === null) camera.clearColor = new Color(0, 0, 0, 0)
    else camera.clearColor = new Color().fromString(normalizeHex(color))
    this.requestRender()
  }

  /** The vertical field of view of the picture, in degrees */
  setFov(fov: number) {
    this.lens = fov
    this.applyFov()
  }

  get fov() {
    return this.lens
  }

  /**
   * Compose for a picture of a given shape (width / height) rather than the canvas's own:
   * a video frame, say. The field of view is vertical, so a picture narrower than the
   * canvas is simply the middle of it, and `frameRect` says which part. One wider than the
   * canvas would run off both sides, so the camera's lens is widened until it fits across,
   * and the picture is then a band across the middle. Either way, what lies inside
   * `frameRect` is exactly what a render of that shape will show. null turns it off.
   */
  setFrameAspect(aspect: number | null) {
    this.frameAspect = aspect && aspect > 0 ? aspect : null
    this.applyFov()
  }

  /** Where the picture being composed for sits in the canvas, in CSS pixels; null when it is the whole canvas. */
  frameRect(): { x: number; y: number; width: number; height: number } | null {
    const { clientWidth, clientHeight } = this.canvas
    if (!this.frameAspect || clientWidth === 0 || clientHeight === 0) return null
    const width = Math.min(clientWidth, clientHeight * this.frameAspect)
    const height = width / this.frameAspect
    return { x: (clientWidth - width) / 2, y: (clientHeight - height) / 2, width, height }
  }

  private applyFov() {
    const camera = this.camera.camera
    if (!camera) return
    let fov = this.lens
    const frame = this.offlineRatio === null ? this.frameRect() : null
    // the frame is shorter than the canvas: the canvas has to see that much more, above and below
    if (frame && frame.height < this.canvas.clientHeight - 0.5) {
      const half = Math.tan((fov * Math.PI) / 360) * (this.canvas.clientHeight / frame.height)
      fov = Math.min((Math.atan(half) * 360) / Math.PI, 170)
    }
    if (Math.abs(camera.fov - fov) > 1e-4) {
      camera.fov = fov
      // an orthographic view takes its size from the lens
      if (this.controls.orthographic) this.controls.refresh()
    }
    this.requestRender()
  }

  /** Render now and return the canvas as an image blob (posters, thumbnails). */
  async capture(type = 'image/webp', quality = 0.9): Promise<Blob> {
    this.app.render()
    // the drawing buffer is only guaranteed until the browser composites, so read it in this task
    const url = this.canvas.toDataURL(type, quality)
    return (await fetch(url)).blob()
  }

  // ── splats ───────────────────────────────────────────────────────────────

  /**
   * Load a splat and add it to the scene. `data` is passed to the engine's parser (the editor
   * asks for decompressed data so it can export). `prepare` runs after the file is parsed and
   * before the splat is first drawn, which is when extra per-splat streams must be declared.
   */
  async addSplat(
    input: SplatInput,
    transform: Pick<SplatSource, 'position' | 'rotation' | 'scale'> = {},
    options: { data?: Record<string, unknown>; prepare?: (resource: GSplatResourceBase) => void; signal?: AbortSignal } = {},
  ): Promise<LoadedSplat> {
    const isFile = 'file' in input
    const filename = isFile ? input.file.name : (input.filename ?? filenameOf(input.url))
    const url = isFile ? URL.createObjectURL(input.file) : input.url
    // the engine picks its parser from `filename`, which a blob: URL does not carry
    const asset = new Asset(filename, 'gsplat', { url, filename }, options.data ?? {})
    if (isFile) this.objectUrls.set(asset, url)

    const resource = await new Promise<GSplatResourceBase>((resolve, reject) => {
      const fail = (reason: unknown) => {
        this.releaseAsset(asset)
        reject(reason instanceof Error ? reason : new Error(String(reason)))
      }
      options.signal?.addEventListener('abort', () => fail(new DOMException('Load aborted', 'AbortError')), { once: true })
      asset.on('progress', (received: number, total: number) => {
        this.events.emit('progress', total > 0 ? Math.min(received / total, 1) : -1)
      })
      asset.once('load', () => resolve(asset.resource as GSplatResourceBase))
      asset.once('error', (err: unknown) => fail(typeof err === 'string' ? new Error(err) : err))
      this.app.assets.add(asset)
      this.app.assets.load(asset)
    })

    if (this.destroyed || options.signal?.aborted) {
      this.releaseAsset(asset)
      throw new DOMException('Load aborted', 'AbortError')
    }

    options.prepare?.(resource)

    const entity = new Entity(filename, this.app)
    const [px, py, pz] = transform.position ?? [0, 0, 0]
    const [rx, ry, rz] = transform.rotation ?? DEFAULT_ROTATION
    const [sx, sy, sz] = transform.scale ?? [1, 1, 1]
    entity.setLocalPosition(px, py, pz)
    entity.setLocalEulerAngles(rx, ry, rz)
    entity.setLocalScale(sx, sy, sz)
    entity.addComponent('gsplat', { asset })
    this.app.root.addChild(entity)

    const splat: LoadedSplat = { entity, asset, resource, filename, src: isFile ? null : input.url }
    this.splats.push(splat)
    // the first frames after a load are still sorting; keep drawing until they settle
    this.requestRender(4)
    return splat
  }

  removeSplat(splat: LoadedSplat) {
    const index = this.splats.indexOf(splat)
    if (index < 0) return
    this.splats.splice(index, 1)
    splat.entity.destroy()
    this.releaseAsset(splat.asset)
    this.requestRender(2)
  }

  clear() {
    for (const splat of [...this.splats]) this.removeSplat(splat)
  }

  private releaseAsset(asset: Asset) {
    asset.off()
    if (!this.destroyed) {
      asset.unload()
      this.app.assets.remove(asset)
    }
    const url = this.objectUrls.get(asset)
    if (url) {
      URL.revokeObjectURL(url)
      this.objectUrls.delete(asset)
    }
  }

  // ── framing ──────────────────────────────────────────────────────────────

  /**
   * Bounding sphere of what is worth looking at, in world space. Real captures carry far-off
   * floaters that blow up the true bounds, so this trims each axis to its 2nd–98th percentile.
   */
  getFocus(): { center: Vec3; radius: number } | null {
    const box = new BoundingBox()
    let any = false
    for (const splat of this.splats) {
      const local = robustBounds(splat.resource)
      if (!local) continue
      const world = new BoundingBox()
      world.setFromTransformedAabb(local, splat.entity.getWorldTransform())
      if (any) box.add(world)
      else box.copy(world)
      any = true
    }
    if (!any) return null
    return { center: box.center.clone(), radius: Math.max(box.halfExtents.length(), 1e-3) }
  }

  /**
   * Point the camera at the scene from a three-quarter view, or with `keepDirection` from
   * wherever it is looking now.
   */
  frameScene(animate = false, keepDirection = false) {
    const focus = this.getFocus()
    if (!focus) return
    const { clientWidth, clientHeight } = this.canvas
    // not laid out yet (hidden tab, closed dialog, display: none): fit a square for now and
    // frame again once the canvas has a real shape
    this.framePending = clientWidth === 0 || clientHeight === 0
    const aspect = this.framePending ? 1 : clientWidth / clientHeight
    if (!keepDirection) {
      this.controls.yaw = 30
      this.controls.pitch = -18
    }
    // the trimmed box is tight around the subject; pull back a little for breathing room
    this.controls.frame(focus.center, focus.radius * 0.85, this.fov, aspect)
    if (!animate) this.controls.snap()
    this.requestRender()
  }

  // ── teardown ─────────────────────────────────────────────────────────────

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.resizeObserver.disconnect()
    this.controls.destroy()
    this.events.clear()
    for (const url of this.objectUrls.values()) URL.revokeObjectURL(url)
    this.objectUrls.clear()
    this.splats.length = 0
    this.app.destroy()
  }
}

/** Accepts #rgb, #rrggbb, #rrggbbaa; anything else falls back to black. */
function normalizeHex(color: string) {
  const hex = color.trim()
  if (/^#[0-9a-f]{3}$/i.test(hex)) return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) return hex
  return '#000000'
}

const SAMPLE_LIMIT = 40_000
/** Longest to wait for one frame's depth sort before taking the frame as it is, in milliseconds */
const SORT_TIMEOUT = 3000

/**
 * Yield to the event loop without a timer. Timers are throttled to once a second when the
 * page is not in front, which would turn a one-minute render into an hour.
 */
export const nextTask = () =>
  new Promise<void>((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })

function robustBounds(resource: GSplatResourceBase): BoundingBox | null {
  // streamed LOD resources have no CPU-side centers; their stored bounds are the best there is
  const centers = resource.hasCenters ? resource.centers : null
  const count = centers ? Math.floor(centers.length / 3) : 0
  if (!centers || count < 16) return resource.aabb ?? null

  const stride = Math.max(1, Math.floor(count / SAMPLE_LIMIT))
  const n = Math.floor(count / stride)
  const axes = [new Float32Array(n), new Float32Array(n), new Float32Array(n)]
  for (let i = 0; i < n; i++) {
    const o = i * stride * 3
    axes[0][i] = centers[o]
    axes[1][i] = centers[o + 1]
    axes[2][i] = centers[o + 2]
  }
  const lo: number[] = []
  const hi: number[] = []
  for (const axis of axes) {
    axis.sort()
    lo.push(axis[Math.floor(n * 0.02)])
    hi.push(axis[Math.min(n - 1, Math.floor(n * 0.98))])
  }
  const box = new BoundingBox()
  box.setMinMax(new Vec3(lo[0], lo[1], lo[2]), new Vec3(hi[0], hi[1], hi[2]))
  return box
}

export const tupleOf = (v: Vec3): Vec3Tuple => {
  const round = (n: number) => Math.round(n * 1e4) / 1e4
  return [round(v.x), round(v.y), round(v.z)]
}
