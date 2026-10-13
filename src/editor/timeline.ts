import type { Keyframe } from '../core/scene'
import { button, h, icons, number, recall, remember, setValue, trim } from './dom'
import type { Editor } from './editor'

/** Counted in seconds, keys snap to this grid while dragged. Counted in frames, they snap to frames. Hold Shift to place freely. */
const SNAP = 0.05
const DRAG_SLOP = 3

const SECOND_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300, 600]
const FRAME_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000]
/** About ten labelled ticks, on a round number of seconds or frames */
const niceStep = (length: number, steps: number[]) => steps.find((step) => step >= length / 10) ?? steps[steps.length - 1]

/**
 * The timeline dock: transport, a ruler with the playhead, and one row per animated
 * property with its keyframes. It owns no animation state; it draws what the editor holds
 * and calls the editor to change it.
 */
export function buildTimeline(root: HTMLElement, editor: Editor) {
  let selected: { target: string; key: Keyframe } | null = null

  // ── transport and keying ─────────────────────────────────────────────────

  const play = button('Play', () => editor.togglePlay(), { icon: icons.play, title: 'Play / pause (Space)' })
  const toStart = button('To start', () => editor.setTime(0), { icon: icons.toStart, title: 'Back to the start (Home)' })
  // times are kept in seconds; the timeline can count them in frames instead, as Blender's does
  const inFrames = () => editor.timeUnits === 'frames'
  const toUnits = (t: number) => (inFrames() ? Math.round(t * editor.fps) : t)
  const fromUnits = (value: number) => (inFrames() ? value / editor.fps : value)
  const snap = (t: number) => {
    const step = inFrames() ? 1 / editor.fps : SNAP
    return Math.round(t / step) * step
  }
  const stamp = (t: number) => (inFrames() ? `Frame ${toUnits(t)}` : `${trim(t, 2)} s`)

  const time = number((value) => editor.setTime(fromUnits(value)), { step: SNAP, min: 0 })
  const duration = number((value) => editor.setDuration(fromUnits(value)), { step: 1, min: 0 })
  const timeCaption = h('span', {})
  const units = h('select', { title: 'Count the timeline in seconds or in frames' }, h('option', { value: 'seconds' }, 'Seconds'), h('option', { value: 'frames' }, 'Frames'))
  units.setAttribute('aria-label', 'Timeline units')
  units.addEventListener('change', () => {
    remember('timeUnits', units.value)
    editor.setTimeUnits(units.value as 'seconds' | 'frames')
  })
  const fps = number((value) => editor.setFps(value), { step: 1, min: 1, max: 240, title: 'Frames per second: what a frame is worth, and the rate of a rendered video. Changing it does not change how long anything takes.' })
  editor.timeUnits = recall<string>('timeUnits', 'seconds') === 'frames' ? 'frames' : 'seconds'
  const loop = h('input', { type: 'checkbox' })
  loop.addEventListener('change', () => editor.setLoop(loop.checked))

  const autoKey = button('Auto-key', () => editor.setAutoKey(!editor.autoKey), {
    class: 'record',
    title: 'While on, changing an animatable property writes a key at the playhead',
  })
  autoKey.prepend(h('span', { class: 'icon', innerHTML: icons.record }))
  const keyObject = button('Key', () => editor.keySelected(), {
    title: 'Key what you are editing at the playhead: the active force or section box, otherwise the splat (K)',
  })
  const keyCamera = button('Key camera', () => editor.keyCamera(), {
    title: 'Key the current view as the camera’s position at the playhead (Shift+K)',
  })
  const follow = h('input', { type: 'checkbox' })
  follow.addEventListener('change', () => editor.setFollowCamera(follow.checked))

  const ease = h('select', { title: 'How the selected key travels to the next one', attrs: { 'aria-label': 'Easing of the selected key' } },
    h('option', { value: 'smooth' }, 'Smooth'),
    h('option', { value: 'linear' }, 'Linear'),
    h('option', { value: 'hold' }, 'Hold'),
  )
  ease.addEventListener('change', () => {
    if (selected) editor.setKeyEase(selected.key, ease.value as NonNullable<Keyframe['ease']>)
  })
  const removeKey = button('Delete the selected key', () => deleteSelected(), { icon: icons.trash, title: 'Delete the selected key (Delete)' })

  const bar = h('div', { class: 'tl-bar' },
    toStart,
    play,
    h('label', { class: 'tl-field tl-now' }, timeCaption, time),
    h('label', { class: 'tl-field tl-length' }, h('span', {}, 'Length'), duration),
    units,
    h('label', { class: 'tl-field tl-fps' }, fps, h('span', {}, 'fps')),
    h('label', { class: 'check' }, loop, 'Loop'),
    h('span', { class: 'sep' }),
    autoKey,
    keyObject,
    keyCamera,
    h('label', { class: 'check', title: 'Look through the animated camera. Off leaves the viewport free and draws the camera’s path.' }, follow, 'Through camera'),
    h('span', { class: 'spacer' }),
    ease,
    removeKey,
  )

  // ── ruler, rows, playhead ────────────────────────────────────────────────

  const rulerLane = h('div', { class: 'tl-lane tl-ruler' })
  const rows = h('div', { class: 'tl-rows' })
  const playhead = h('div', { class: 'tl-playhead' })
  const body = h('div', { class: 'tl-body' }, h('div', { class: 'tl-row tl-head' }, h('div', { class: 'tl-label' }), rulerLane), rows, playhead)
  root.append(bar, body)

  const fraction = (t: number) => (editor.animation.duration > 0 ? Math.min(Math.max(t / editor.animation.duration, 0), 1) : 0)
  /** The time under a pointer, measured against a lane */
  const timeAt = (lane: HTMLElement, clientX: number) => {
    const rect = lane.getBoundingClientRect()
    return rect.width > 0 ? ((clientX - rect.left) / rect.width) * editor.animation.duration : 0
  }

  /** Counted in frames, the playhead lands on frames */
  const scrubTime = (lane: HTMLElement, clientX: number) => (inFrames() ? snap(timeAt(lane, clientX)) : timeAt(lane, clientX))

  /** Dragging along a lane's background moves the playhead. */
  function bindScrub(lane: HTMLElement) {
    let pointerId: number | null = null
    lane.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !editor.doc) return
      pointerId = e.pointerId
      try {
        lane.setPointerCapture(e.pointerId)
      } catch {
        // not an active pointer
      }
      editor.pause()
      editor.setTime(scrubTime(lane, e.clientX))
    })
    lane.addEventListener('pointermove', (e) => {
      if (e.pointerId === pointerId) editor.setTime(scrubTime(lane, e.clientX))
    })
    const end = (e: PointerEvent) => {
      if (e.pointerId === pointerId) pointerId = null
    }
    lane.addEventListener('pointerup', end)
    lane.addEventListener('pointercancel', end)
  }
  bindScrub(rulerLane)

  function select(next: typeof selected) {
    selected = next
    for (const node of rows.querySelectorAll<HTMLElement>('.tl-key-mark')) node.classList.remove('selected')
    syncSelection()
  }

  function deleteSelected(): boolean {
    if (!selected) return false
    const { target, key } = selected
    selected = null
    editor.removeKey(target, key)
    return true
  }

  function keyMark(lane: HTMLElement, target: string, key: Keyframe) {
    const mark = h('button', { type: 'button', class: 'tl-key-mark', title: stamp(key.t) })
    mark.style.left = `${fraction(key.t) * 100}%`
    if (selected?.key === key) mark.classList.add('selected')

    let pointerId: number | null = null
    let startX = 0
    let dragging = false
    mark.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      e.stopPropagation()
      pointerId = e.pointerId
      startX = e.clientX
      dragging = false
      try {
        mark.setPointerCapture(e.pointerId)
      } catch {
        // not an active pointer
      }
      select({ target, key })
      mark.classList.add('selected')
    })
    mark.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pointerId) return
      if (!dragging) {
        if (Math.abs(e.clientX - startX) < DRAG_SLOP) return
        dragging = true
        editor.pause()
        editor.beginKeyEdit()
      }
      const raw = timeAt(lane, e.clientX)
      editor.moveKey(target, key, e.shiftKey ? raw : snap(raw))
      // moved by hand rather than by a redraw, which would drop the pointer mid-drag
      mark.style.left = `${fraction(key.t) * 100}%`
      mark.title = stamp(key.t)
    })
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return
      pointerId = null
      if (dragging) editor.endKeyEdit()
      // a plain click on a key jumps the playhead to it
      else editor.setTime(key.t)
    }
    mark.addEventListener('pointerup', end)
    mark.addEventListener('pointercancel', end)
    return mark
  }

  let trackCount = 0

  /** Rebuild the ruler and the rows from the editor's tracks. */
  function render() {
    const { animation } = editor
    // a key that no longer exists (deleted, or replaced by an undo) cannot stay selected
    if (selected && !animation.tracks.some((track) => track.target === selected!.target && track.keys.includes(selected!.key))) selected = null

    // the ruler counts what the fields count: seconds, or frames
    const scale = inFrames() ? editor.fps : 1
    const length = animation.duration * scale
    const step = niceStep(length, inFrames() ? FRAME_STEPS : SECOND_STEPS)
    const ticks: HTMLElement[] = []
    for (let at = 0; at <= length + 1e-6; at += step) {
      const tick = h('span', { class: 'tl-tick' }, trim(at, 1))
      tick.style.left = `${fraction(at / scale) * 100}%`
      // a tick at the very end has no room to its right
      if (at >= length - step * 0.04) tick.classList.add('tl-tick-end')
      ticks.push(tick)
    }
    rulerLane.replaceChildren(...ticks)

    if (animation.tracks.length === 0) {
      rows.replaceChildren(
        h('p', { class: 'tl-empty fine' },
          editor.doc
            ? 'Nothing is animated yet. Move the playhead, then click the diamond beside any property in the panel to key it here. K keys everything about what you are editing (the splat, or the force or box you pressed Edit on), and Key camera keys the view. With Auto-key on, any change you make is keyed for you.'
            : 'Open a splat to animate it.'),
      )
    } else {
      rows.replaceChildren(
        ...animation.tracks.map((track) => {
          const lane = h('div', { class: 'tl-lane' })
          bindScrub(lane)
          // double-click on empty lane: a key there, with the value the track has at that time
          lane.addEventListener('dblclick', (e) => {
            if (e.target !== lane) return
            editor.setTime(timeAt(lane, e.clientX))
            editor.keyTrack(track.target)
          })
          lane.append(...track.keys.map((key) => keyMark(lane, track.target, key)))
          const label = h('div', { class: 'tl-label' },
            h('span', { title: track.target }, editor.trackLabel(track.target)),
            button('Add key', () => editor.keyTrack(track.target), { icon: icons.diamond, title: 'Add a key to this track at the playhead' }),
            button('Remove track', () => editor.removeTrack(track.target), { icon: icons.close, title: 'Remove this track and all its keys' }),
          )
          return h('div', { class: 'tl-row' }, label, lane)
        }),
      )
    }

    // a property keyed for the first time gets a new row at the bottom: show it
    if (animation.tracks.length > trackCount && trackCount > 0) rows.lastElementChild?.scrollIntoView({ block: 'nearest' })
    trackCount = animation.tracks.length

    const frames = inFrames()
    setValue(duration, frames ? String(Math.max(Math.round(animation.duration * editor.fps), 1)) : trim(animation.duration, 2))
    setValue(fps, trim(editor.fps, 3))
    if (document.activeElement !== units) units.value = editor.timeUnits
    timeCaption.textContent = frames ? 'Frame' : 'Time'
    time.step = frames ? '1' : String(SNAP)
    time.title = frames ? 'The frame the playhead is on' : 'Playhead, in seconds'
    duration.title = frames ? `Length of the animation, in frames (${trim(animation.duration, 2)} s at ${trim(editor.fps, 3)} fps)` : 'Length of the animation, in seconds'
    loop.checked = animation.loop !== false
    autoKey.setAttribute('aria-pressed', String(editor.autoKey))
    follow.checked = editor.followCamera
    const hasDoc = !!editor.doc
    for (const control of [play, toStart, time, duration, units, fps, loop, autoKey, keyObject, keyCamera, follow]) control.disabled = !hasDoc
    syncSelection()
    syncTime()
  }

  function syncSelection() {
    ease.disabled = removeKey.disabled = !selected
    if (selected && document.activeElement !== ease) ease.value = selected.key.ease ?? 'smooth'
  }

  /** The playhead moved: cheap, and called every frame during playback. */
  function syncTime() {
    playhead.style.setProperty('--at', String(fraction(editor.time)))
    setValue(time, inFrames() ? String(toUnits(editor.time)) : editor.time.toFixed(2))
    const playing = editor.playing
    if (play.dataset.playing !== String(playing)) {
      play.dataset.playing = String(playing)
      play.innerHTML = playing ? icons.pause : icons.play
    }
  }

  editor.events.on('animation', render)
  editor.events.on('doc', render)
  editor.events.on('time', syncTime)
  render()

  return { deleteSelected }
}
