import { AnnotationLayer } from '../core/annotations'
import { Emitter } from '../core/events'
import { fetchScene, parseScene, sceneFromSrc, DEFAULT_BACKGROUND, DEFAULT_FOV, type CameraPose, type DeviceType, type SplatScene } from '../core/scene'
import { SplatEffects } from '../core/effects'
import { sectionTest } from '../core/sections'
import { SplatViewer } from '../core/viewer'
import { icons, playerCss } from './style'

export type { Annotation, CameraPose, ControlLimits, DeviceType, Force, ForceType, SectionBox, SplatScene, SplatSource, Vec3Tuple } from '../core/scene'

export interface SplatPlayerOptions {
  /** A scene file URL (from the editor's "Export scene"), or the scene object itself */
  scene?: string | SplatScene
  /** Shortcut for a scene with one splat and default settings: the splat file URL */
  src?: string
  /** Image shown until the splat has loaded. Overrides the scene's own poster. */
  poster?: string
  /**
   * When to download the splat:
   * - 'visible' (default): as the player nears the viewport
   * - 'click': after the viewer presses the start button (best for large files)
   * - 'eager': immediately
   */
  load?: 'visible' | 'click' | 'eager'
  /**
   * How the player shares the pointer with the page:
   * - 'activate' (default): dragging always orbits, but the scroll wheel and one-finger
   *   vertical swipes keep scrolling the page until the viewer clicks or taps inside
   * - 'always': the player takes every gesture (full-page and lightbox use)
   */
  interaction?: 'activate' | 'always'
  /** Show the built-in controls (reset, fullscreen, viewpoints). Default true. */
  ui?: boolean
  /** Overrides the scene background. A CSS hex color, or null for a transparent canvas. */
  background?: string | null
  /** Overrides the scene's idle rotation, in degrees per second */
  autoRotate?: number
  /** Start with the scene's section boxes applied. Default true; the viewer can toggle them. */
  sections?: boolean
  /** Start with the scene's text callouts showing. Default true; the viewer can toggle them. */
  annotations?: boolean
  /**
   * Start with the scene's force fields running. Default true, except for viewers who ask
   * their system for reduced motion; either way the viewer can toggle them.
   */
  forces?: boolean
  /** Accessible name for the 3D view */
  label?: string
  /** Text of the start button in 'click' mode */
  startLabel?: string
  /**
   * Graphics API. Default: WebGPU for scenes with force fields (it sorts moving splats
   * correctly; see the README), WebGL 2 otherwise. WebGPU falls back to WebGL 2.
   */
  device?: DeviceType
  maxPixelRatio?: number
}

export type PlayerState = 'idle' | 'loading' | 'ready' | 'error'

type PlayerEvents = {
  /** 0..1, or -1 while the size is unknown */
  progress: [fraction: number]
  load: []
  error: [error: Error]
  /** The viewer stepped to a saved viewpoint; -1 = back to the initial view */
  pose: [index: number]
  state: [state: PlayerState]
}

/** Frames to wait for the engine to report the splat sorted before showing the canvas anyway */
const FIRST_FRAME_LIMIT = 300

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'
const aborted = () => new DOMException('The player was destroyed', 'AbortError')
const isHexColor = (color: string) => /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color.trim())

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, html?: string) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (html) node.innerHTML = html
  return node
}

const button = (label: string, icon: string, onClick: () => void) => {
  const node = el('button', undefined, icon)
  node.type = 'button'
  node.title = label
  node.setAttribute('aria-label', label)
  node.addEventListener('click', onClick)
  return node
}

/**
 * An embeddable Gaussian splat viewer. Give it an element with a size and a scene:
 *
 * ```ts
 * const player = new SplatPlayer(element, { scene: '/media/works/piece/scene.json' })
 * // later, e.g. on React unmount
 * player.destroy()
 * ```
 *
 * Nothing is downloaded and no WebGL context is created until the player is about to be
 * seen, and rendering stops whenever it scrolls out of view.
 */
export class SplatPlayer {
  readonly options: Readonly<SplatPlayerOptions>
  /** Resolves once the splat is on screen; rejects if it cannot be shown */
  readonly loaded: Promise<void>

  private readonly host: HTMLElement
  private readonly shadow: ShadowRoot
  private readonly events = new Emitter<PlayerEvents>()
  private readonly abort = new AbortController()
  private readonly ui: {
    poster: HTMLImageElement | null
    center: HTMLElement
    progress: HTMLElement
    progressFill: HTMLElement
    poses: HTMLElement
    poseLabel: HTMLElement
    fullscreen: HTMLButtonElement | null
    sections: HTMLButtonElement
    annotations: HTMLButtonElement
    forces: HTMLButtonElement
    live: HTMLElement
  }

  private viewer: SplatViewer | null = null
  private scene: SplatScene | null = null
  private effects: SplatEffects[] = []
  private callouts: AnnotationLayer | null = null
  private sectionsOn: boolean
  private annotationsOn: boolean
  private forcesOn: boolean
  private initialPose: CameraPose | null = null
  private poseIndex = -1
  private _state: PlayerState = 'idle'
  private started = false
  private visible = false
  private active = false
  private destroyed = false
  private settle!: { resolve: () => void; reject: (e: Error) => void }
  private visibility: IntersectionObserver | null = null

  constructor(container: HTMLElement, options: SplatPlayerOptions = {}) {
    if (!options.scene && !options.src) throw new Error('SplatPlayer needs a "scene" or a "src"')
    this.options = { ...options }
    this.sectionsOn = options.sections ?? true
    this.annotationsOn = options.annotations ?? true
    this.forcesOn = options.forces ?? !prefersReducedMotion()
    this.loaded = new Promise<void>((resolve, reject) => (this.settle = { resolve, reject }))
    // a caller that only listens for events must not see an unhandled rejection
    this.loaded.catch(() => {})

    this.host = el('div')
    this.host.dataset.state = 'idle'
    this.shadow = this.host.attachShadow({ mode: 'open' })
    const style = el('style')
    style.textContent = playerCss
    this.shadow.append(style)
    this.ui = this.buildUi()
    container.append(this.host)

    const signal = this.abort.signal
    document.addEventListener('fullscreenchange', () => this.onFullscreenChange(), { signal })
    // a press anywhere else hands the wheel and touch gestures back to the page
    document.addEventListener('pointerdown', (e) => { if (!e.composedPath().includes(this.host)) this.setActive(false) }, { signal })

    const inline = typeof options.scene === 'object' ? options.scene : null
    this.setPoster(options.poster ?? inline?.poster)

    const mode = options.load ?? 'visible'
    this.visibility = new IntersectionObserver(
      (entries) => {
        // entries can batch several crossings; the last one is the current state
        this.visible = entries[entries.length - 1].isIntersecting
        if (this.visible) {
          if (mode === 'visible') void this.load()
          this.viewer?.resume()
        } else {
          this.viewer?.pause()
          this.setActive(false)
        }
      },
      { rootMargin: '200px 0px' },
    )
    this.visibility.observe(this.host)

    if (mode === 'eager') void this.load()
    if (mode === 'click') this.showStart()
  }

  // ── public API ───────────────────────────────────────────────────────────

  get state() {
    return this._state
  }

  /** The saved viewpoints of the loaded scene */
  get poses(): readonly CameraPose[] {
    return this.scene?.poses ?? []
  }

  on<K extends keyof PlayerEvents>(type: K, listener: (...args: PlayerEvents[K]) => void) {
    return this.events.on(type, listener)
  }

  /** Start downloading and showing the splat. Safe to call more than once. */
  load(): Promise<void> {
    if (!this.started && !this.destroyed) {
      this.started = true
      this.run().then(
        () => this.settle.resolve(),
        (error: unknown) => {
          const err = error instanceof Error ? error : new Error(String(error))
          // torn down mid-load: nothing to report, but `loaded` must not resolve
          if (!this.destroyed && !isAbort(error)) this.fail(err)
          this.settle.reject(err)
        },
      )
    }
    return this.loaded
  }

  /** Move to a saved viewpoint by index, or to any pose. */
  setPose(pose: number | CameraPose, animate = true) {
    if (!this.viewer) return
    const index = typeof pose === 'number' ? pose : -1
    const target = typeof pose === 'number' ? this.poses[pose] : pose
    if (!target) return
    this.viewer.controls.setPose(target, animate && !prefersReducedMotion())
    this.viewer.requestRender()
    this.poseIndex = index
    this.updatePoseLabel()
    this.events.emit('pose', index)
  }

  /** Return to the view the scene opens with. */
  reset(animate = true) {
    if (!this.viewer || !this.initialPose) return
    this.viewer.controls.setPose(this.initialPose, animate && !prefersReducedMotion())
    this.viewer.requestRender()
    this.poseIndex = -1
    this.updatePoseLabel()
    this.events.emit('pose', -1)
  }

  /** The camera's current position and target, e.g. to save a viewpoint. */
  getPose(): CameraPose | null {
    return this.viewer?.controls.getPose() ?? null
  }

  /** Whether the scene's section boxes are currently cutting the splat */
  get sectionsEnabled() {
    return this.sectionsOn
  }

  /** Apply or lift the scene's section boxes, e.g. to show a cut-away and then the whole. */
  setSectionsEnabled(enabled: boolean) {
    this.sectionsOn = enabled
    this.applySceneLayers()
  }

  get annotationsVisible() {
    return this.annotationsOn
  }

  /** Show or hide the scene's text callouts. */
  setAnnotationsVisible(visible: boolean) {
    this.annotationsOn = visible
    this.applySceneLayers()
  }

  get forcesEnabled() {
    return this.forcesOn
  }

  /** Start or still the scene's force fields. Stilled, every splat is back in its place. */
  setForcesEnabled(enabled: boolean) {
    this.forcesOn = enabled
    this.applySceneLayers()
  }

  toggleFullscreen() {
    if (document.fullscreenElement === this.host) void document.exitFullscreen()
    else void this.host.requestFullscreen?.().catch(() => {})
  }

  /** Release the WebGL context, workers and DOM. Safe to call more than once and mid-load. */
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.abort.abort()
    this.visibility?.disconnect()
    this.callouts?.destroy()
    this.callouts = null
    this.effects = []
    this.viewer?.destroy()
    this.viewer = null
    this.events.clear()
    this.host.remove()
  }

  // ── loading ──────────────────────────────────────────────────────────────

  private async run() {
    const { options } = this
    const signal = this.abort.signal
    this.setState('loading')
    this.ui.center.hidden = true
    this.setProgress(-1)

    const scene =
      typeof options.scene === 'string'
        ? await fetchScene(options.scene, signal)
        : options.scene
          ? parseScene(options.scene, document.baseURI)
          : sceneFromSrc(options.src!)
    if (this.destroyed) throw aborted()
    this.scene = scene
    if (!this.ui.poster) this.setPoster(scene.poster)

    const background = options.background !== undefined ? options.background : scene.background !== undefined ? scene.background : DEFAULT_BACKGROUND
    this.host.toggleAttribute('data-transparent', background === null)
    // scene files are untrusted input: only a plain hex color may reach the stylesheet
    if (background && isHexColor(background)) this.host.style.setProperty('--splat-bg', background.trim())

    const canvas = el('canvas')
    canvas.tabIndex = 0
    canvas.setAttribute('role', 'application')
    canvas.setAttribute('aria-label', options.label ?? scene.name ?? 'Interactive 3D view')
    canvas.setAttribute('aria-describedby', 'splat-help')
    // keep it under the poster and the controls
    this.shadow.insertBefore(canvas, this.shadow.querySelector('style')!.nextSibling)

    const viewer = await SplatViewer.create(canvas, {
      device: options.device ?? (scene.forces?.length ? 'webgpu' : 'webgl2'),
      maxPixelRatio: options.maxPixelRatio,
      transparent: background === null,
    })
    // destroyed while the device was being created (React StrictMode mounts twice)
    if (this.destroyed) {
      viewer.destroy()
      throw aborted()
    }
    this.viewer = viewer

    viewer.setBackground(background)
    viewer.setFov(scene.camera?.fov ?? DEFAULT_FOV)

    const { controls } = viewer
    const limits = scene.controls ?? {}
    if (limits.minDistance !== undefined) controls.limits.minDistance = limits.minDistance
    if (limits.maxDistance !== undefined) controls.limits.maxDistance = limits.maxDistance
    if (limits.minPitch !== undefined) controls.limits.minPitch = limits.minPitch
    if (limits.maxPitch !== undefined) controls.limits.maxPitch = limits.maxPitch
    if (limits.pan !== undefined) controls.limits.pan = limits.pan
    controls.autoRotate = prefersReducedMotion() ? 0 : (options.autoRotate ?? limits.autoRotate ?? 0)
    controls.wheelEnabled = this.interaction === 'always'
    controls.onInteract = () => this.host.removeAttribute('data-hint')
    this.bindInteraction(canvas)

    // a lost context cannot be repaired in place; say so instead of showing a frozen frame
    canvas.addEventListener('webglcontextlost', () => this.fail(new Error('The 3D view was closed by the browser to free graphics memory.')), { signal })

    let index = 0
    const off = viewer.events.on('progress', (fraction) => {
      this.setProgress(fraction < 0 ? -1 : (index + fraction) / scene.splats.length)
    })
    for (const splat of scene.splats) {
      await viewer.addSplat({ url: splat.src, filename: splat.filename }, splat, { signal })
      index++
    }
    off()
    if (this.destroyed) throw aborted()

    if (scene.camera?.initial) controls.setPose(scene.camera.initial)
    else viewer.frameScene()
    this.initialPose = controls.getPose()

    this.effects = viewer.splats.map((splat) => new SplatEffects(splat.entity.gsplat!))
    this.callouts = new AnnotationLayer(this.shadow, viewer.camera, canvas, this.ui.center)
    this.applySceneLayers()
    viewer.events.on('update', (dt) => {
      // running forces move splats every frame, so the picture is never still
      let moving = false
      for (const effect of this.effects) moving = effect.advance(dt) || moving
      if (moving) viewer.requestRender()
      this.callouts?.update()
    })

    await this.firstFrame(viewer)
    if (this.destroyed) throw aborted()

    this.setProgress(1)
    this.updatePoseLabel()
    this.ui.poses.hidden = this.poses.length === 0
    this.setState('ready')
    this.host.toggleAttribute('data-hint', true)
    // an embed that loaded offscreen (eager) should not spin until it is seen
    if (!this.visible) viewer.pause()
    this.events.emit('load')
  }

  /** Resolve once the splat has been sorted and drawn, so the poster never fades to a blank canvas. */
  private firstFrame(viewer: SplatViewer) {
    return new Promise<void>((resolve) => {
      const gsplat = viewer.app.systems.gsplat
      const done = () => {
        gsplat?.off('frame:ready', onReady)
        offUpdate()
        resolve()
      }
      const onReady = (_camera: unknown, _layer: unknown, ready: boolean) => {
        if (ready) done()
      }
      // The fallback counts frames, not seconds: a background tab or a slow device gets few
      // frames, and a wall-clock timeout would uncover a canvas that has not been drawn yet.
      let frames = 0
      const offUpdate = viewer.events.on('update', () => {
        viewer.requestRender()
        if (++frames > FIRST_FRAME_LIMIT) done()
      })
      gsplat?.on('frame:ready', onReady)
    })
  }

  /** Push the section and callout switches to the splats, the overlay and the buttons. */
  private applySceneLayers() {
    const scene = this.scene
    if (!scene) return
    const sections = scene.sections ?? []
    const annotations = scene.annotations ?? []
    const forces = scene.forces ?? []
    const active = this.sectionsOn ? sections : []
    for (const effect of this.effects) {
      effect.setSections(active)
      effect.setForces(this.forcesOn ? forces : [])
    }
    if (this.callouts) {
      // a callout whose point has been cut away goes with it
      this.callouts.set(annotations, sectionTest(active))
      this.callouts.visible = this.annotationsOn && annotations.length > 0
    }
    this.syncToggle(this.ui.sections, sections.length > 0, this.sectionsOn, 'Show the whole', 'Show the cut-away')
    this.syncToggle(this.ui.annotations, annotations.length > 0, this.annotationsOn, 'Hide labels', 'Show labels')
    this.syncToggle(this.ui.forces, forces.length > 0, this.forcesOn, 'Still the flow', 'Set it flowing')
    this.viewer?.requestRender(3)
  }

  private syncToggle(node: HTMLButtonElement, available: boolean, on: boolean, whenOn: string, whenOff: string) {
    node.hidden = !available
    node.setAttribute('aria-pressed', String(on))
    node.title = on ? whenOn : whenOff
    node.setAttribute('aria-label', node.title)
  }

  private fail(error: Error) {
    if (this.destroyed) return
    this.callouts?.destroy()
    this.callouts = null
    this.effects = []
    this.viewer?.destroy()
    this.viewer = null
    this.shadow.querySelector('canvas')?.remove()
    this.setState('error')
    this.ui.center.hidden = false
    this.ui.center.replaceChildren(el('div', 'error', '<span></span>'))
    this.ui.center.querySelector('span')!.textContent = `Could not show this 3D view. ${error.message}`
    this.ui.live.textContent = '3D view failed to load'
    this.events.emit('error', error)
  }

  // ── interaction ──────────────────────────────────────────────────────────

  private get interaction() {
    return this.options.interaction ?? 'activate'
  }

  private bindInteraction(canvas: HTMLCanvasElement) {
    const signal = this.abort.signal
    // a mouse press means "I am using this now"; a touch only counts once it ends as a tap or
    // drag, because the press that starts a page scroll looks identical until it moves
    canvas.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'touch') this.setActive(true) }, { signal })
    canvas.addEventListener('pointerup', (e) => { if (e.pointerType === 'touch') this.setActive(true) }, { signal })
    canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') this.setActive(false) }, { signal })
    canvas.addEventListener('keydown', (e) => this.onKeyDown(e), { signal })
    canvas.addEventListener('dblclick', () => this.reset(), { signal })
  }

  private setActive(active: boolean) {
    const always = this.interaction === 'always' || document.fullscreenElement === this.host
    active = active || always
    if (this.active === active) return
    this.active = active
    this.host.toggleAttribute('data-active', active)
    if (this.viewer) this.viewer.controls.wheelEnabled = active
  }

  private onKeyDown(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const key = e.key.toLowerCase()
    if (key === 'escape') {
      this.setActive(false)
    } else if (key === 'r' || key === '0') {
      this.reset()
    } else if (key === 'f') {
      this.toggleFullscreen()
    } else if (key === 'l' && this.scene?.annotations?.length) {
      this.setAnnotationsVisible(!this.annotationsOn)
    } else if (key === 'c' && this.scene?.sections?.length) {
      this.setSectionsEnabled(!this.sectionsOn)
    } else if (key === ' ' && this.scene?.forces?.length) {
      this.setForcesEnabled(!this.forcesOn)
    } else if (key === '[' || key === ']') {
      this.stepPose(key === ']' ? 1 : -1)
    } else if (key >= '1' && key <= '9' && this.poses[Number(key) - 1]) {
      this.setPose(Number(key) - 1)
    } else return
    e.preventDefault()
  }

  private stepPose(delta: number) {
    const count = this.poses.length
    if (count === 0) return
    const from = this.poseIndex < 0 ? (delta > 0 ? -1 : 0) : this.poseIndex
    this.setPose((from + delta + count) % count)
  }

  private onFullscreenChange() {
    const full = document.fullscreenElement === this.host
    if (this.ui.fullscreen) {
      this.ui.fullscreen.innerHTML = full ? icons.exitFullscreen : icons.fullscreen
      const label = full ? 'Exit full screen' : 'Full screen'
      this.ui.fullscreen.title = label
      this.ui.fullscreen.setAttribute('aria-label', label)
    }
    this.setActive(full)
    this.viewer?.requestRender(2)
  }

  // ── UI ───────────────────────────────────────────────────────────────────

  private buildUi(): SplatPlayer['ui'] {
    const showUi = this.options.ui ?? true
    const touch = window.matchMedia('(pointer: coarse)').matches

    const center = el('div', 'center')
    center.hidden = true

    const progress = el('div', 'progress', '<i></i>')

    const poseLabel = el('span', 'label')
    const poses = el('div', 'bar start')
    poses.hidden = true
    poses.append(
      button('Previous viewpoint', icons.prev, () => this.stepPose(-1)),
      poseLabel,
      button('Next viewpoint', icons.next, () => this.stepPose(1)),
    )

    const tools = el('div', 'bar end')
    const fullscreen = document.fullscreenEnabled ? button('Full screen', icons.fullscreen, () => this.toggleFullscreen()) : null
    // both stay hidden until a loaded scene turns out to have something for them to switch
    const sections = button('Show the whole', icons.section, () => this.setSectionsEnabled(!this.sectionsOn))
    const annotations = button('Hide labels', icons.label, () => this.setAnnotationsVisible(!this.annotationsOn))
    const forces = button('Still the flow', icons.flow, () => this.setForcesEnabled(!this.forcesOn))
    sections.hidden = annotations.hidden = forces.hidden = true
    tools.append(forces, annotations, sections, button('Reset view', icons.reset, () => this.reset()))
    if (fullscreen) tools.append(fullscreen)

    const hint = el('div', 'hint')
    hint.textContent =
      this.interaction === 'always'
        ? touch ? 'Drag to look around · pinch to zoom' : 'Drag to look around · scroll to zoom'
        : touch ? 'Drag to look around · tap for full control' : 'Drag to look around · click, then scroll to zoom'

    // read by assistive tech as the description of the canvas
    const help = el('div', 'sr-only')
    help.id = 'splat-help'
    help.textContent = 'Arrow keys orbit. Plus and minus zoom. R resets the view. F toggles full screen. Bracket keys step through saved viewpoints. L shows or hides labels. C switches the cut-away. Space starts or stills the flow.'

    const live = el('div', 'sr-only')
    live.setAttribute('role', 'status')
    live.setAttribute('aria-live', 'polite')

    this.shadow.append(center, progress, hint, help, live)
    if (showUi) this.shadow.append(poses, tools)
    return { poster: null, center, progress, progressFill: progress.firstElementChild as HTMLElement, poses, poseLabel, fullscreen: showUi ? fullscreen : null, sections, annotations, forces, live }
  }

  private setPoster(url: string | undefined) {
    if (!url || this.ui.poster) return
    const img = el('img', 'poster')
    img.alt = ''
    img.decoding = 'async'
    img.draggable = false
    img.src = url
    // a missing poster must not leave a broken-image icon over the stage
    img.addEventListener('error', () => img.remove())
    this.ui.poster = img
    this.shadow.insertBefore(img, this.ui.center)
  }

  private showStart() {
    const start = el('button', 'start-button', `${icons.cube}<span></span>`)
    start.type = 'button'
    start.querySelector('span')!.textContent = this.options.startLabel ?? 'View in 3D'
    start.addEventListener('click', () => void this.load())
    this.ui.center.replaceChildren(start)
    this.ui.center.hidden = false
  }

  private setState(state: PlayerState) {
    this._state = state
    this.host.dataset.state = state
    if (state === 'loading') this.ui.live.textContent = 'Loading 3D view'
    if (state === 'ready') this.ui.live.textContent = '3D view loaded'
    this.events.emit('state', state)
  }

  private setProgress(fraction: number) {
    this.ui.progress.classList.toggle('indeterminate', fraction < 0)
    this.ui.progressFill.style.width = fraction < 0 ? '' : `${Math.round(fraction * 100)}%`
    this.events.emit('progress', fraction)
  }

  private updatePoseLabel() {
    const count = this.poses.length
    if (count === 0) return
    const pose = this.poses[this.poseIndex]
    this.ui.poseLabel.textContent = pose ? (pose.name ?? `${this.poseIndex + 1} / ${count}`) : `${count} views`
  }
}

/**
 * Register `<splat-player>` for pages that are not built with a framework:
 *
 * ```html
 * <splat-player scene="scene.json" poster="poster.webp" style="aspect-ratio: 16 / 9"></splat-player>
 * ```
 *
 * Attributes mirror the options: scene, src, poster, load, interaction, background
 * ("transparent" for none), auto-rotate, label, device, no-ui, no-sections, no-annotations, no-forces. It fires `splat-load`, `splat-error`
 * and `splat-progress` events. The player instance is on the element's `player` property.
 */
export function defineSplatPlayerElement(tag = 'splat-player') {
  if (customElements.get(tag)) return

  class SplatPlayerElement extends HTMLElement {
    static observedAttributes = ['scene', 'src']
    player: SplatPlayer | null = null

    connectedCallback() {
      if (!this.style.display) this.style.display = 'block'
      this.mount()
    }

    disconnectedCallback() {
      this.player?.destroy()
      this.player = null
    }

    attributeChangedCallback(_name: string, before: string | null, after: string | null) {
      if (this.isConnected && before !== after) this.mount()
    }

    private mount() {
      this.player?.destroy()
      this.player = null
      const attr = (name: string) => this.getAttribute(name) ?? undefined
      const scene = attr('scene')
      const src = attr('src')
      if (!scene && !src) return
      const background = attr('background')
      const autoRotate = attr('auto-rotate')
      const player = new SplatPlayer(this, {
        scene,
        src,
        poster: attr('poster'),
        load: attr('load') as SplatPlayerOptions['load'],
        interaction: attr('interaction') as SplatPlayerOptions['interaction'],
        background: background === undefined ? undefined : background === 'transparent' ? null : background,
        autoRotate: autoRotate === undefined ? undefined : Number(autoRotate) || 0,
        label: attr('label'),
        ui: !this.hasAttribute('no-ui'),
        sections: !this.hasAttribute('no-sections'),
        annotations: !this.hasAttribute('no-annotations'),
        forces: this.hasAttribute('no-forces') ? false : undefined,
        device: attr('device') as SplatPlayerOptions['device'],
      })
      player.on('load', () => this.dispatchEvent(new CustomEvent('splat-load')))
      player.on('error', (error) => this.dispatchEvent(new CustomEvent('splat-error', { detail: error })))
      player.on('progress', (fraction) => this.dispatchEvent(new CustomEvent('splat-progress', { detail: fraction })))
      this.player = player
    }
  }

  customElements.define(tag, SplatPlayerElement)
}
