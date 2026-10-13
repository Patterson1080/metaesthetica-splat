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
  /** The selected keys, each with the track it is on */
  const selection = new Map<Keyframe, string>()
  /** The diamond drawn for each key, so a drag can move several by hand */
  let marks = new Map<Keyframe, HTMLElement>()
  /** The pointer is over the dock: Ctrl+A then means its keys, not the splats */
  let hovered = false
  root.addEventListener('pointerenter', () => (hovered = true))
  root.addEventListener('pointerleave', () => (hovered = false))

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

  const ease = h('select', { title: 'How the selected keys travel to the next one', attrs: { 'aria-label': 'Easing of the selected keys' } },
    h('option', { value: 'smooth' }, 'Smooth'),
    h('option', { value: 'linear' }, 'Linear'),
    h('option', { value: 'hold' }, 'Hold'),
    // shown, never chosen: the selected keys do not all travel the same way
    h('option', { value: 'mixed', hidden: true }, 'Mixed'),
  )
  ease.addEventListener('change', () => {
    if (selection.size && ease.value !== 'mixed') editor.setKeysEase([...selection.keys()], ease.value as NonNullable<Keyframe['ease']>)
  })
  const removeKey = button('Delete the selected keys', () => deleteSelected(), { icon: icons.trash, title: 'Delete the selected keys (Delete)' })

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

  /** Dragging along the ruler moves the playhead. */
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

  /** Color the diamonds by what is selected, and bring the key controls in line. */
  function paint() {
    for (const [key, node] of marks) node.classList.toggle('selected', selection.has(key))
    syncSelection()
  }

  function setSelection(keys: Iterable<[Keyframe, string]>) {
    selection.clear()
    for (const [key, target] of keys) selection.set(key, target)
    paint()
  }

  function deleteSelected(): boolean {
    if (selection.size === 0) return false
    const keys = [...selection].map(([key, target]) => ({ target, key }))
    selection.clear()
    editor.removeKeys(keys)
    return true
  }

  function keyMark(lane: HTMLElement, target: string, key: Keyframe) {
    const mark = h('button', { type: 'button', class: 'tl-key-mark', title: stamp(key.t) })
    mark.style.left = `${fraction(key.t) * 100}%`
    if (selection.has(key)) mark.classList.add('selected')
    marks.set(key, mark)

    let pointerId: number | null = null
    let startX = 0
    let dragging = false
    /** Shift or Ctrl was held: the press changed the selection and is not a jump to the key */
    let toggled = false
    /** Where the selected keys were when the drag began, and how far the pointer was from this one */
    let origin = new Map<Keyframe, number>()
    let grip = 0
    mark.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      e.stopPropagation()
      startX = e.clientX
      dragging = false
      toggled = e.shiftKey || e.ctrlKey || e.metaKey
      if (toggled) {
        // add this key to the selection, or take it out
        if (selection.has(key)) selection.delete(key)
        else selection.set(key, target)
        paint()
        // a key just deselected is not about to be dragged
        if (!selection.has(key)) return
      } else if (!selection.has(key)) {
        setSelection([[key, target]])
      }
      // pressing a key that is already selected keeps the others, so the group can be dragged by it
      pointerId = e.pointerId
      try {
        mark.setPointerCapture(e.pointerId)
      } catch {
        // not an active pointer
      }
    })
    mark.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pointerId) return
      if (!dragging) {
        if (Math.abs(e.clientX - startX) < DRAG_SLOP) return
        dragging = true
        origin = new Map([...selection.keys()].map((selected) => [selected, selected.t]))
        grip = timeAt(lane, startX) - key.t
        editor.pause()
        editor.beginKeyEdit()
      }
      // this key follows the pointer; the rest of the selection keeps its distance from it
      const from = origin.get(key) ?? key.t
      const to = timeAt(lane, e.clientX) - grip
      const times = [...origin.values()]
      const shift = Math.min(Math.max((e.shiftKey ? to : snap(to)) - from, -Math.min(...times)), editor.animation.duration - Math.max(...times))
      editor.moveKeys([...origin].map(([moved, t]) => ({ target: selection.get(moved) ?? target, key: moved, t: t + shift })))
      // moved by hand rather than by a redraw, which would drop the pointer mid-drag
      for (const moved of origin.keys()) {
        const node = marks.get(moved)
        if (!node) continue
        node.style.left = `${fraction(moved.t) * 100}%`
        node.title = stamp(moved.t)
      }
    })
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return
      pointerId = null
      if (dragging) return editor.endKeyEdit(origin.size > 1 ? `Move ${origin.size} keys` : 'Move key')
      if (toggled) return
      // a plain click on a key leaves it the only one selected and jumps the playhead to it
      setSelection([[key, target]])
      editor.setTime(key.t)
    }
    mark.addEventListener('pointerup', end)
    mark.addEventListener('pointercancel', end)
    return mark
  }

  // ── box select: drag across the rows, as in Blender's dope sheet ──

  const marquee = h('div', { class: 'tl-marquee', hidden: true })
  body.append(marquee)
  let box: { pointerId: number; x: number; y: number; dragging: boolean; base: Map<Keyframe, string>; mode: 'set' | 'add' | 'remove' } | null = null
  body.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !editor.doc) return
    // only on empty track, or the empty space under the rows: the ruler scrubs, the labels have buttons
    const on = e.target as HTMLElement
    const lane = on.classList.contains('tl-lane') && !on.classList.contains('tl-ruler')
    if (!lane && on !== rows && on !== body) return
    box = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, dragging: false, base: new Map(selection), mode: e.shiftKey ? 'add' : e.ctrlKey || e.metaKey ? 'remove' : 'set' }
    try {
      body.setPointerCapture(e.pointerId)
    } catch {
      // not an active pointer
    }
    // or the drag would select the track names as text
    e.preventDefault()
  })
  body.addEventListener('pointermove', (e) => {
    if (!box || e.pointerId !== box.pointerId) return
    if (!box.dragging) {
      if (Math.hypot(e.clientX - box.x, e.clientY - box.y) < DRAG_SLOP) return
      box.dragging = true
      marquee.hidden = false
    }
    const left = Math.min(box.x, e.clientX)
    const right = Math.max(box.x, e.clientX)
    const top = Math.min(box.y, e.clientY)
    const bottom = Math.max(box.y, e.clientY)
    // the box lives inside the scrolling body, so it is placed in the body's own coordinates
    const frame = body.getBoundingClientRect()
    marquee.style.left = `${left - frame.left + body.scrollLeft}px`
    marquee.style.top = `${top - frame.top + body.scrollTop}px`
    marquee.style.width = `${right - left}px`
    marquee.style.height = `${bottom - top}px`

    // Shift adds what the box covers to what was selected, Ctrl takes it away, neither replaces it
    const next = new Map(box.mode === 'set' ? [] : box.base)
    for (const track of editor.animation.tracks) {
      for (const key of track.keys) {
        const rect = marks.get(key)?.getBoundingClientRect()
        if (!rect) continue
        const cx = rect.left + rect.width / 2
        const cy = rect.top + rect.height / 2
        if (cx < left || cx > right || cy < top || cy > bottom) continue
        if (box.mode === 'remove') next.delete(key)
        else next.set(key, track.target)
      }
    }
    setSelection(next)
  })
  const endBox = (e: PointerEvent) => {
    if (!box || e.pointerId !== box.pointerId) return
    // a click on empty track that never became a drag deselects, unless it was adding or removing
    if (!box.dragging && box.mode === 'set' && e.type === 'pointerup') setSelection([])
    box = null
    marquee.hidden = true
  }
  body.addEventListener('pointerup', endBox)
  body.addEventListener('pointercancel', endBox)

  let trackCount = 0

  /** Rebuild the ruler and the rows from the editor's tracks. */
  function render() {
    const { animation } = editor
    // a key that no longer exists (deleted, or replaced by an undo) cannot stay selected
    const alive = new Set(animation.tracks.flatMap((track) => track.keys))
    for (const key of [...selection.keys()]) if (!alive.has(key)) selection.delete(key)
    marks = new Map()

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
    const count = selection.size
    ease.disabled = removeKey.disabled = count === 0
    removeKey.title = count > 1 ? `Delete the ${count} selected keys (Delete)` : 'Delete the selected key (Delete)'
    if (count === 0 || document.activeElement === ease) return
    const eases = new Set([...selection.keys()].map((key) => key.ease ?? 'smooth'))
    ease.value = eases.size === 1 ? [...eases][0] : 'mixed'
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

  return {
    deleteSelected,
    /** Select every key. Returns false when there are none. */
    selectAll(): boolean {
      const all = editor.animation.tracks.flatMap((track) => track.keys.map((key) => [key, track.target] as [Keyframe, string]))
      if (all.length === 0) return false
      setSelection(all)
      return true
    },
    /** Deselect the keys. Returns false when none were selected. */
    clearSelection(): boolean {
      if (selection.size === 0) return false
      setSelection([])
      return true
    },
    get hovered() {
      return hovered
    },
  }
}
