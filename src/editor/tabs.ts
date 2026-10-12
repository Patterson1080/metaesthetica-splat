import { h, recall, remember } from './dom'

export interface TabSpec {
  id: string
  /** The caption under the icon: one short word */
  label: string
  /** The heading over the tab's groups */
  title: string
  icon: string
  groups: HTMLElement[]
}

/**
 * The properties panel, organised the way Blender's is: a rail of tabs down one edge, one
 * subject per tab, and under each a few collapsible groups. Only one tab's groups are in
 * view at a time, so no subject is ever more than a click and a short scroll away.
 */
export function buildTabs(panel: HTMLElement, specs: TabSpec[]) {
  const rail = h('nav', { class: 'tabs', attrs: { role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': 'Properties' } })
  const body = h('div', { class: 'tab-body' })
  const tabs = new Map<string, { button: HTMLButtonElement; pane: HTMLElement; badge: HTMLElement }>()
  let current = ''

  specs.forEach((spec) => {
    const badge = h('span', { class: 'tab-badge', hidden: true })
    const button = h('button', {
      type: 'button',
      class: 'tab',
      id: `tab-${spec.id}`,
      title: spec.title,
      attrs: { role: 'tab', 'aria-controls': `pane-${spec.id}`, 'aria-selected': 'false' },
      on: { click: () => select(spec.id) },
    })
    button.innerHTML = spec.icon
    button.append(h('span', { class: 'tab-label' }, spec.label), badge)
    const pane = h('div', { class: 'tab-pane', id: `pane-${spec.id}`, hidden: true, attrs: { role: 'tabpanel', 'aria-labelledby': `tab-${spec.id}` } },
      h('h2', { class: 'tab-title' }, spec.title),
      ...spec.groups,
    )
    tabs.set(spec.id, { button, pane, badge })
    rail.append(button)
    body.append(pane)
  })

  // the rail is one tab stop; the arrow keys move along it
  rail.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    const ids = specs.map((spec) => spec.id)
    const at = ids.indexOf(current)
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + ids.length) % ids.length
    select(ids[next])
    tabs.get(ids[next])!.button.focus()
    e.preventDefault()
    e.stopPropagation()
  })

  function select(id: string) {
    if (!tabs.has(id) || id === current) return
    current = id
    for (const [key, tab] of tabs) {
      const on = key === id
      tab.button.setAttribute('aria-selected', String(on))
      tab.button.tabIndex = on ? 0 : -1
      tab.pane.hidden = !on
    }
    body.scrollTop = 0
    remember('tab', id)
  }

  /** A small count on a tab, so a list's size shows without opening it. Empty or 0 clears it. */
  function setBadge(id: string, count: number) {
    const badge = tabs.get(id)?.badge
    if (!badge) return
    badge.hidden = count <= 0
    badge.textContent = String(count)
  }

  panel.append(rail, body)
  select(recall('tab', specs[0].id))
  if (!current) select(specs[0].id)

  return {
    select,
    setBadge,
    get current() {
      return current
    },
  }
}
