import { h } from './dom'
import type { Editor } from './editor'

interface Toggle {
  row: HTMLElement
  button: HTMLButtonElement
  /** The track this row keys right now, or null when it has nothing to key (no force is being edited, say) */
  target: () => string | null
}

/**
 * The small diamond at the end of every property that can be animated, as in Blender's
 * Properties editor. It shows how the property stands at the playhead and keys it on a click:
 *
 *   ·  a dot       not animated; click to key it here
 *   ◇  hollow      animated, with no key at the playhead; click to add one
 *   ◆  filled      a key sits at the playhead; click to take it away
 *   orange         the value was changed by hand and differs from its animation; click to key it
 *
 * The row is tinted the same way, so a glance down a panel shows what is animated.
 */
export function createKeyToggles(editor: Editor) {
  const toggles: Toggle[] = []

  /** Give a property row its diamond. `target` is asked afresh every time, since it follows what is being edited. */
  function attach(row: HTMLElement, target: () => string | null) {
    const button = h('button', { type: 'button', class: 'key-toggle', data: { state: 'none' } }, h('span', {}))
    button.addEventListener('click', (e) => {
      // the row is a <label>: without this the click would also land on its first input
      e.preventDefault()
      const to = target()
      if (to) editor.toggleKey(to)
    })
    row.classList.add('keyable')
    // last in the row, so the label keeps pointing at its input
    row.append(button)
    toggles.push({ row, button, target })
  }

  /** Bring the diamonds in line with the timeline. `only` limits it to some tracks (the camera's, while it moves). */
  function sync(only?: (target: string) => boolean) {
    for (const { row, button, target } of toggles) {
      const to = target()
      if (only && (!to || !only(to))) continue
      const state = to ? editor.keyState(to) : { animated: false, onKey: false, changed: false }
      // a row's label can change with what is being edited ("Strength" becomes "Speed °/s")
      const name = row.querySelector('span')?.textContent ?? 'This property'
      const shape = !state.animated ? 'none' : state.onKey ? 'keyed' : 'animated'
      const tint = state.changed ? 'changed' : shape
      button.dataset.state = shape
      button.dataset.changed = String(state.changed)
      button.disabled = !to
      row.dataset.key = tint
      const hint = state.changed
        ? `${name} differs from its animation here. Click to key the new value.`
        : shape === 'keyed'
          ? `${name} has a key here. Click to remove it.`
          : shape === 'animated'
            ? `${name} is animated. Click to add a key here.`
            : `Key ${name} at the playhead`
      button.title = hint
      button.setAttribute('aria-label', hint)
    }
  }

  return { attach, sync }
}

export type KeyToggles = ReturnType<typeof createKeyToggles>
