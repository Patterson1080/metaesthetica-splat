// Entry for player.html: a full-window player configured from the URL, usable on its own or
// as an <iframe> target.
//
//   player.html?scene=<scene.json>            a scene exported from the editor
//   player.html?src=<file.ply|.sog>           a bare splat with default settings
//   &poster=<image>  &bg=<hex without #|transparent>  &autorotate=<deg/s>  &load=click

import { SplatPlayer, type SplatPlayerOptions } from './index'

const params = new URLSearchParams(location.search)
const root = document.getElementById('player')!
const framed = window.self !== window.top

const scene = params.get('scene') ?? undefined
const src = params.get('src') ?? undefined
const bg = params.get('bg')
const autoRotate = params.get('autorotate')
const load = params.get('load')
const device = params.get('device')

if (!scene && !src) {
  root.textContent = 'Add ?scene=<scene.json> or ?src=<splat file> to the URL.'
  root.classList.add('message')
} else {
  const options: SplatPlayerOptions = {
    scene,
    src,
    poster: params.get('poster') ?? undefined,
    background: bg === null ? undefined : bg === 'transparent' ? null : `#${bg.replace(/^#/, '')}`,
    autoRotate: autoRotate === null ? undefined : Number(autoRotate) || 0,
    load: load === 'click' ? 'click' : 'eager',
    // inside an iframe the wheel should keep scrolling the parent page until the viewer clicks in
    interaction: framed ? 'activate' : 'always',
    device: device === 'webgpu' || device === 'webgl2' ? device : undefined,
  }
  const player = new SplatPlayer(root, options)
  // handy from the console and for automated checks
  ;(window as unknown as { player: SplatPlayer }).player = player
}
