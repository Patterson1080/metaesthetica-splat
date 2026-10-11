# Splat Engine

A Gaussian splat **editor** and embeddable **player** for the web, built on the [PlayCanvas engine](https://github.com/playcanvas/engine) for [Metaesthetica](https://metaesthetica.xyz).

- **Editor** (`index.html`): open a capture, remove what does not belong, place it, cut it open with section boxes, pin text labels to it, set it flowing with force fields, stage the camera, export.
- **Player** (`src/player`): a small viewer for the exported scene, with no framework dependency, built to sit inside a scrolling content page.

Stack: Vite · TypeScript · PlayCanvas 2.23. No backend; everything runs in the browser.

## Run

```sh
npm install
npm run dev        # http://localhost:5183
```

| Page | What it is |
| --- | --- |
| `/` | the editor (`?load=<splat url>` or `?scene=<scene url>` opens a file directly) |
| `/player.html?scene=samples/knot.scene.json` | the player full-window; also the `<iframe>` target |
| `/demo.html` | the player embedded five ways in a long page: the reference for embedding |

```sh
npm run build      # typecheck, then dist/ (the three pages) and dist-lib/ (the player library)
npm run sample     # regenerate the procedural sample splats in public/samples/
```

## Workflow

1. **Open** a `.ply`, `.compressed.ply` or `.sog` (drag and drop, or Open…).
2. **Clean up.** Select with the rectangle, lasso or brush, or let *Clean-up* select faint splats or everything beyond a radius, then press Delete. Everything is undoable.
3. **Place.** Move, rotate and scale with the gizmos or by number. Captures usually arrive upside down; *Flip upright* fixes that.
4. **Compose** (all optional, all stored in the scene file rather than baked into the splat):
   - **Section boxes** hide part of the splat. Shown is what lies inside any *keep* box, minus what lies inside any *cut* box.
   - **Labels** are text callouts pinned to points on the splat.
   - **Forces** set the splat's own points flowing: swirl, wind, attract/repel, turbulence.
5. **Stage.** Field of view, start view, saved viewpoints, zoom and pitch limits, auto-rotate, background. *Preview* runs the real player on the edited scene.
6. **Export** the splat (`.ply`), the scene (`.scene.json`) and a poster (`.webp`).
7. **Compress for the web** and point the scene at the result:

   ```sh
   npx @playcanvas/splat-transform name.ply name.sog
   ```

   `.sog` is the format to publish. The procedural sample shrinks from 4.2 MB to 0.8 MB; real captures, which carry spherical harmonics, typically shrink far more.

### Section boxes

Add a *keep* or *cut* box, press **Edit** on its row, and the move, rotate and scale tools act on the box instead of the splat (Esc hands them back). A new keep box starts as a slice through the middle, facing the camera, so it does something the moment it appears.

Boxes are non-destructive and the player lets viewers switch them off. What the boxes leave out is either **faded** (the *Rest of the splat* opacity slider) or, with **Hide the rest**, not drawn at all, so a box can single out one part while the whole stays faintly present. While a box is on, selection only touches what is in full view, so a box doubles as a mask for cleaning up. **Delete the rest** makes the cut permanent, which also shrinks the export.

A box can also stand for a **component** of the splat. Tick *Label this box* and the player outlines it as a hairline cube with the box's name set above it and a description below.

### Labels

With the Label tool (`A`), click the splat to pin a label; drag its text to move it, drag its dot to re-pin it. Each label has a title and optional body text.

Pinned labels and box labels share one look: a title in tracked capitals over a hairline rule with a tick at each end, plain text beneath, and **no background**, only a soft halo in the stage color for legibility. They are real HTML text over the canvas, so they stay sharp at any pixel ratio and are readable by assistive technology. The typeface is Avenir (`Avenir Next`, then `Avenir`). Avenir ships with Apple systems only, so elsewhere the labels fall back to the system sans unless the page provides the face and names it in `--splat-label-font`. A label whose point is no longer drawn (hidden by a section box, not merely faded) disappears with it.

### Forces

A force has a position, an orientation and a reach. It moves the splat's own points: the splats within reach leave their place, travel along the force's motion, fade out and start again from home. Nothing is added to the splat, and by default each moving splat keeps its own shape and color (a swirl also turns it, so streaks stay aligned with their orbit). Fewer splats are carried toward the edge of the reach, so the motion thins out rather than ending at a line.

| Kind | Motion | Strength means |
| --- | --- | --- |
| Swirl | orbits the force's axis, faster near the core; optional lift along the axis and pull toward it | degrees per second |
| Wind | blows along the force's axis | units per second |
| Attract | draws toward the center; negative repels | rate per second |
| Turbulence | drifts through a tangle of steady currents | units per second |

Every force also has *travel time* and *wander* with an *eddy size* for organic irregularity, plus three choices about how the motion looks: *draw as* (**Splats**, each moving splat in its own shape, or **Points only**, plain round points of one *point size*), *share moving* (below 1, the rest of the splats stay put and hold the form) and *tint* (above 0, what moves takes on a color). Press **Edit** to move a force with the gizmo; scaling changes its reach.

The motion is computed in closed form on the GPU from a clock, with no per-splat simulation state, so it costs little and looks the same everywhere. Two consequences:

- **Depth ordering needs WebGPU.** On WebGPU the engine sorts splats on the GPU from where they actually are. On WebGL 2 it sorts on the CPU from where they rest, so splats carried in front of others can be drawn behind them. The player therefore asks for WebGPU when a scene has forces and falls back to WebGL 2, where the flow still runs.
- A scene with running forces renders every frame while on screen, instead of only when the camera moves.

Forces rest in the editor while a selection tool is in use, because selection works on splats where they rest.

### Editor shortcuts

| Key | Action |
| --- | --- |
| `V` `R` `L` `B` | navigate · rectangle · lasso · brush |
| `1` `2` `3` | move · rotate · scale (the splat, or the box or force being edited) |
| `A` | label tool |
| `Shift` / `Ctrl` + drag | add to / remove from the selection |
| `Alt` + drag, right-drag | orbit while a selection tool is active |
| `[` `]` | brush size |
| `Delete` | delete the selection (or, with the label tool, the active label) |
| `Ctrl+A` · `Ctrl+I` | select all · invert |
| `Esc` | back out: clear the selection, then stop editing a box or force, then return to navigate |
| `Ctrl+Z` · `Ctrl+Shift+Z` | undo · redo |
| `F` | frame the splat |

## Embedding the player

`npm run build` writes `dist-lib/splat-player.js` (one ES module, engine included) and its types in `dist-lib/types/`.

```ts
import { SplatPlayer } from 'splat-engine/player' // or a relative path to splat-player.js

const player = new SplatPlayer(element, {
  scene: '/media/piece/piece.scene.json',
  poster: '/media/piece/piece.webp',
})

player.destroy() // when the element goes away
```

The element only needs a size (`aspect-ratio`, or a height). Without a framework:

```html
<script type="module">
  import { defineSplatPlayerElement } from './splat-player.js'
  defineSplatPlayerElement()
</script>
<splat-player scene="piece.scene.json" poster="piece.webp" style="aspect-ratio: 16 / 9"></splat-player>
```

Or as an iframe: `player.html?scene=<url>&poster=<url>`.

For the Metaesthetica website specifically, see [docs/WEBSITE-INTEGRATION.md](docs/WEBSITE-INTEGRATION.md).

### What it does for the page around it

- **Lazy.** Nothing is downloaded and no graphics context exists until the player nears the viewport (`load: 'visible'`), or until the visitor presses the start button (`load: 'click'`). Until then it shows the poster.
- **Scroll-friendly.** With `interaction: 'activate'` (the default) a drag orbits straight away, but the wheel and one-finger vertical swipes keep scrolling the page until the visitor clicks or taps inside.
- **Idle is free.** It renders only when something changes and stops its frame loop when scrolled out of view.
- **Isolated styling.** Controls and labels live in a shadow root, so page CSS does not reach them. They inherit the page font.
- **Accessible.** Keyboard orbit and zoom, labelled controls, live status, labels as real text; no auto-rotate, animated moves or running forces under `prefers-reduced-motion` unless the visitor turns them on.
- `destroy()` is safe mid-load and when called twice, so it works as a React effect cleanup, including StrictMode's double mount.

Viewers get buttons for whatever the scene contains: saved viewpoints, labels on/off (`L`), the cut-away on/off (`C`), the flow on/off (`Space`), reset (`R`) and full screen (`F`).

### Options

| Option | Default | |
| --- | --- | --- |
| `scene` | | URL of a scene file, or the scene object |
| `src` | | shortcut: URL of a splat, default settings |
| `poster` | scene's | image shown until the splat is on screen |
| `load` | `'visible'` | `'visible'` · `'click'` · `'eager'` |
| `interaction` | `'activate'` | `'activate'` · `'always'` (lightbox, full page) |
| `background` | scene's | hex color, or `null` for a transparent canvas |
| `autoRotate` | scene's | degrees per second while idle |
| `sections` | `true` | start with the scene's section boxes applied |
| `annotations` | `true` | start with the scene's labels showing |
| `forces` | `true`, `false` under reduced motion | start with the scene's forces running |
| `ui` | `true` | built-in controls |
| `label` | scene name | accessible name of the 3D view |
| `device` | `'webgpu'` for scenes with forces, else `'webgl2'` | WebGPU falls back to WebGL 2 |
| `maxPixelRatio` | `2` | cap on device pixel ratio |

Methods: `load()`, `setPose(index | pose)`, `reset()`, `getPose()`, `setSectionsEnabled(bool)`, `setAnnotationsVisible(bool)`, `setForcesEnabled(bool)`, `toggleFullscreen()`, `destroy()`, `on('load' | 'error' | 'progress' | 'pose' | 'state', fn)`. `player.loaded` is a promise for "on screen".

### Theming

| Property | Default | |
| --- | --- | --- |
| `--splat-bg` | `#000` | stage color. With a transparent canvas, set it to the color the player sits on. |
| `--splat-fg` | `#fff` | text and icons |
| `--splat-accent` | `--splat-fg` | focus ring and progress bar |
| `--splat-radius` | `0` | corner radius of the stage |
| `--splat-label-font` | Avenir Next, Avenir, system sans | label typeface |
| `--splat-label-color` | `--splat-fg` | label text, rules, leader and dot |
| `--splat-label-bg` | `transparent` | fill behind label text, if one is wanted after all |
| `--splat-label-width` | `18em` | widest a pinned label may get |

### Scene file

```json
{
  "version": 1,
  "name": "Piece",
  "splats": [{ "src": "piece.sog", "position": [0, 0, 0], "rotation": [0, 0, 180], "scale": [1, 1, 1] }],
  "camera": { "fov": 50, "initial": { "position": [2.6, 1.3, 3.4], "target": [0, 0, 0] } },
  "poses": [{ "name": "Front", "position": [0, 0.4, 4.2], "target": [0, 0, 0] }],
  "controls": { "minDistance": 0.4, "maxDistance": 9, "minPitch": -89, "maxPitch": 12, "pan": true, "autoRotate": 6 },
  "background": "#000000",
  "poster": "piece.webp",
  "sections": [
    { "name": "Far loop", "position": [-0.95, 0.05, 0], "rotation": [0, 0, 0], "size": [1.5, 1.9, 2.9], "mode": "keep",
      "label": true, "text": "Shown under the box when it is labelled." }
  ],
  "sectionRest": { "opacity": 0.12, "hidden": false },
  "annotations": [
    { "title": "Crest", "text": "Highest point of the loop", "position": [-1, 0.63, 0], "offset": [-70, -52] }
  ],
  "forces": [
    {
      "name": "Updraft", "type": "swirl", "position": [0, 0, 0], "rotation": [0, 0, 0], "radius": 2.4, "strength": 55,
      "amount": 1, "cycle": 7, "render": "points", "dotSize": 0.014, "tint": 0,
      "noise": 0.07, "noiseScale": 1.3, "lift": 0.14, "pull": 0
    }
  ]
}
```

`src` and `poster` resolve relative to the scene file, so a scene and its assets can be moved as a folder. Positions are in world space. A label's `offset` is where its text sits relative to its point on screen, in CSS pixels. `sectionRest` says how the splats outside the boxes are shown; without it they are not drawn. Up to 8 section boxes and 4 forces are applied. Supported splat formats: `.ply`, `.compressed.ply`, `.sog`, and SOG `meta.json` / streamed `lod-meta.json`. Files served from another origin need CORS headers.

## Layout

```
src/core/      scene format · SplatViewer (engine wrapper: device, camera, loading, render-on-demand) · orbit controls
               effects (the per-splat shader hook) · sections · forces · annotations (the label layer)
src/player/    SplatPlayer + <splat-player>, its shadow-DOM styles, the player.html entry
src/editor/    Editor model, per-splat edit state, selection tools, undo history, .ply export, UI panels
scripts/       make-sample.mjs: the procedural sample
public/samples knot.ply (raw, with floaters), knot-clean.ply/.sog, and three scenes: plain, infographic, flow
docs/          WEBSITE-INTEGRATION.md
```

How it works: the engine copies every splat into a work buffer before drawing and lets a component hook into that copy to move, resize and recolor splats. `src/core/effects.ts` builds that hook from whatever the scene asks for. Force fields move splats, section boxes hide them, and in the editor one extra byte-per-splat texture carries the selected/deleted flags. Kinds and counts are baked into the shader (GLSL and WGSL), everything else is a uniform, so dragging a box or tuning a force never recompiles. Selection and label pinning project splat centers on the CPU. Export rewrites the source properties for the surviving splats, spherical harmonics included.

## Notes and limits

- The editor works on one splat at a time. The scene format and the player accept several.
- The splat's transform is stored in the scene file, not baked into the exported `.ply`.
- Section boxes, labels and forces are placed in world space; they do not follow the splat if it is moved afterwards.
- Forces are a display effect: they are not written into the exported `.ply`.
- The player bundle is about 430 kB gzipped, nearly all of it engine. Import it dynamically so it never weighs on pages without a splat.
- `public/samples/knot-clean.sog` was made with `splat-transform` from `knot-clean.ply`; regenerate it if you change the sample script.
- `.spz` is not wired up (the engine's parser needs a separate zstd wasm module).
- Not yet tested: touch gestures on real devices, Safari and Firefox, and a real capture with spherical harmonics.
