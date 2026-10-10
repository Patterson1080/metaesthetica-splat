// Entry for index.html: the editor.
//
//   ?load=<splat url>     open a splat by URL
//   ?scene=<scene url>    reopen an exported scene (its splat is resolved relative to it)
//   ?device=webgpu        try WebGPU instead of WebGL 2

import './editor.css'
import { fetchScene } from '../core/scene'
import { Editor } from './editor'
import { bindUi, buildShell } from './ui'

const params = new URLSearchParams(location.search)
const root = document.getElementById('app')!
const shell = buildShell(root)

try {
  const editor = await Editor.create(shell.canvas, shell.overlay, params.get('device') === 'webgpu' ? 'webgpu' : 'webgl2')
  const ui = bindUi(shell, editor)
  // handy from the console and for automated checks
  ;(window as unknown as { editor: Editor }).editor = editor

  const sceneUrl = params.get('scene')
  const loadUrl = params.get('load')
  try {
    if (sceneUrl) {
      const scene = await fetchScene(sceneUrl)
      await editor.open({ url: scene.splats[0].src, filename: scene.splats[0].filename }, scene)
    } else if (loadUrl) {
      await editor.open({ url: loadUrl })
    }
  } catch (error) {
    console.error(error)
    ui.notice(`Could not open ${sceneUrl ?? loadUrl}: ${error instanceof Error ? error.message : String(error)}`, true)
  }
} catch (error) {
  console.error(error)
  const fatal = document.createElement('div')
  fatal.className = 'fatal'
  fatal.textContent = `The editor could not start a 3D context on this device. ${error instanceof Error ? error.message : String(error)}`
  root.replaceChildren(fatal)
}
