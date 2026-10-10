// Entry for demo.html: the player embedded three ways in a page that scrolls.

import { SplatPlayer, defineSplatPlayerElement } from './player/index'

defineSplatPlayerElement()

const log = document.getElementById('log')!
const lines: string[] = []
const note = (text: string) => {
  lines.push(`${(performance.now() / 1000).toFixed(1)}s  ${text}`)
  log.textContent = lines.slice(-8).join('\n')
}

for (const id of ['hero', 'tile', 'infographic', 'flow']) {
  const element = document.getElementById(id)!
  element.addEventListener('splat-load', () => note(`#${id} loaded`))
  element.addEventListener('splat-error', (e) => note(`#${id} failed: ${(e as CustomEvent<Error>).detail.message}`))
}

document.getElementById('theme')!.addEventListener('click', () => {
  const root = document.documentElement
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
  root.dataset.theme = dark ? 'light' : 'dark'
})

// ── the JavaScript API, driven the way a component lifecycle would ───────────

const stage = document.getElementById('api')!
const state = document.getElementById('api-state')!
let player: SplatPlayer | null = null

function mount() {
  if (player) return
  const next = new SplatPlayer(stage, {
    src: 'samples/knot-clean.ply',
    background: null,
    autoRotate: 10,
    label: 'Torus knot on the page background',
  })
  next.on('state', (s) => (state.textContent = `state: ${s}`))
  next.on('load', () => note('#api loaded'))
  next.on('error', (error) => note(`#api failed: ${error.message}`))
  player = next
}

function unmount() {
  player?.destroy()
  player = null
  state.textContent = 'state: unmounted'
}

document.getElementById('mount')!.addEventListener('click', mount)
document.getElementById('unmount')!.addEventListener('click', unmount)
// React 18+ StrictMode runs every effect twice in development: mount, cleanup, mount
document.getElementById('strict')!.addEventListener('click', () => {
  unmount()
  mount()
  unmount()
  mount()
})

mount()
// for automated checks
Object.assign(window, { demo: { mount, unmount, get player() { return player } } })
