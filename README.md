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
| `/demo.html` | the player embedded six ways in a long page: the reference for embedding |

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
5. **Animate** (optional). Keyframe the splat, the camera, forces and section boxes on the timeline.
6. **Stage.** Field of view, start view, saved viewpoints, zoom and pitch limits, auto-rotate, background. *Preview* runs the real player on the edited scene.
7. **Export** the splat (`.ply`), the scene (`.scene.json`) and a poster (`.webp`), or **render** the timeline to a video (`.mp4`).
8. **Compress for the web** and point the scene at the result:

   ```sh
   npx @playcanvas/splat-transform name.ply name.sog
   ```

   `.sog` is the format to publish. The procedural sample shrinks from 4.2 MB to 0.8 MB; real captures, which carry spherical harmonics, typically shrink far more.

### Finding your way around

The editor is laid out like a 3D application: tools down the left edge, the timeline under the viewport, and a **properties panel** on the right organised the way Blender's is.

- A rail of **tabs**, one per subject: *Edit* (selection and clean-up), *Splat* (its transform), *Boxes*, *Forces*, *Labels*, *Camera*, *Player* and *Export*. A small count on the Boxes, Forces and Labels tabs shows how many the scene has.
- Under each tab, a few **collapsible groups** of related properties. A force, for instance, is *Placement*, *Motion* and *Look*. Click a group's heading to fold it; the editor remembers what you left open, and which tab you were on.
- A **?** on a group opens a short explanation of what it does, so the panel shows controls rather than prose.
- Tabs follow what you pick up: a selection tool brings *Edit* forward, the label tool *Labels*, and pressing **Edit** on a box or force its own tab.

### Views

The **navigation gizmo** in the viewport's top right corner is Blender's: the world's axes as the camera sees them. Y is up.

- **Click an end** to look along that axis: X is the right view, Y the top, Z the front. Click the same end again for the opposite side. The view turns there and switches to **orthographic**, so nothing is foreshortened and the splat can be lined up against the grid.
- **Drag** anywhere on the gizmo to orbit. Orbiting out of an axis view returns to perspective by itself, as Blender's auto perspective does. Panning and zooming keep the view.
- Under it: **zoom** and **pan** (drag them), **look through the animated camera**, and **perspective / orthographic**. A projection chosen with that last button stays until you change it.
- The name of the view is written in the top left corner: *Front Orthographic*, *User Perspective*, *Camera Perspective*.

The numpad does the same as in Blender: `1` front, `3` right, `7` top, `9` the opposite side, `5` perspective / orthographic, `0` through the camera, `4` `6` `8` `2` orbit in steps of 15° (with `Ctrl` they pan), `+` `−` zoom, `.` frame the splat. `Ctrl+1` `3` `7` give back, left and bottom, but most browsers keep `Ctrl`+number for switching tabs, so use `9` or a second click on the gizmo.

Orthographic is the editor's viewport only. The player and a rendered video look through the scene's camera, which is always a perspective camera; a poster taken from an orthographic view is taken in perspective from the same place. **Frame** (`F`) brings the splat into view without turning the camera, so an axis view stays one.

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

### Timeline

The dock under the viewport works the way Blender's does: a playhead, one row per animated property, and keyframes you can drag.

**Length and units.** The fields at the left of the dock set the timeline up. *Length* is how long the animation runs; type a new value and press Enter. The dropdown beside it switches the whole dock between **Seconds** and **Frames**: the playhead field, the length, the ruler and the key tooltips all follow, and in frames the playhead and dragged keys land on whole frames. *fps* is the frame rate, 24 unless you change it, and it is also the frame rate of a rendered video. Key times are stored in seconds, so changing the frame rate changes how many frames there are, not how long anything takes.

What can be keyed:

| | Properties |
| --- | --- |
| Splat | position, rotation, scale |
| Camera | position, target, field of view |
| Force | position, rotation, reach, strength, share moving, point size, tint, wander, eddy size, lift, pull |
| Section box | position, rotation, size |
| Rest of the splat | opacity |

Setting keys:

- **The diamond beside a property** keys that property at the playhead, as in Blender's Properties editor. Every property in the table above has one at the end of its row. It also shows where the property stands: a dot for not animated, a hollow green diamond for animated with no key here, a filled yellow one for a key at the playhead (click it to remove that key), and orange when the value was changed by hand and no longer matches its animation (click to key the new value). The row's fields are tinted the same way.
- **`K`** keys everything about what you are editing at the playhead: the force or box you pressed **Edit** on, otherwise the splat.
- **Key camera** (`Shift+K`) keys the current view as the camera at the playhead. Set up a view and move the playhead to where it belongs, in either order, then key; repeat for the next view.
- **Auto-key** is Blender's record button. While it is on, any animatable property you change, by gizmo or by number, is keyed at the playhead, and only the properties that changed. While the viewport is looking through a camera that has keys, moving the view moves the camera and is keyed too, as Blender keys a camera locked to the view.
- Each row has its own add-key button; double-clicking an empty stretch of a row adds a key there.

Working with keys:

- **Select.** Click a key to select it and jump the playhead to it. **Drag across the tracks** to box-select every key the box covers, on as many tracks as it crosses. `Shift`-click adds a key to the selection or takes it out; a box drawn with `Shift` adds, with `Ctrl` removes. `Ctrl+A` with the pointer over the timeline selects every key. Click empty track, or press `Esc`, to deselect.
- **Move.** Drag any selected key and the whole selection moves with it, keeping its spacing. Keys snap to 0.05 s, or to whole frames when the timeline counts in frames; hold `Shift` while dragging to place them freely.
- **Change.** The dropdown at the right of the bar sets how the selected keys travel to the next one (**Smooth**, **Linear** or **Hold**), and Delete removes them.

Drag the **ruler** to scrub; the tracks under it are for selecting. Everything on the timeline is undoable, and moving or deleting a selection is one undo step.

As in Blender, an animated property shows its value at the playhead. If you change one without keying it, the change lasts until the playhead moves; the status bar says so when it happens.

**How values travel between keys.** Smooth keys follow a curve that never swings past them: a value levels off at a peak or a dip, and two equal keys in a row hold still between them, as Blender's auto-clamped handles do. The first and last keys ease in and out. In a looping animation, a track whose last key (at the very end) repeats its first (at 0) is treated as one cycle, so the loop turns over without a pause.

**The camera.** A view is a place to look from and a point to look at, and the two are keyed together: either diamond in *Camera → Viewpoint* keys both. Between keys the camera does not slide along a straight line, which would dive toward the splat between two views of it and pass through it between opposite ones. It travels as an orbit around its target: heading, height and distance each ease from key to key, so views keyed at a steady distance stay at that distance. Each key is reached the short way round, so key a turn of more than half a revolution in two steps. The player flies the camera exactly as keyed, even where that lies outside the zoom and pitch limits set for viewers.

**Camera view and free view.** The viewport is in one of two states, as in Blender, and the corner of the viewport says which.

- *Camera Perspective*: it looks through the animated camera, so scrubbing and playing show the move. **Through camera** in the timeline bar, the camera button under the gizmo and Numpad `0` switch it on and off.
- Any other name: the viewport is free. The camera is drawn in yellow, as a small pyramid at the playhead aimed at its target, on its path with a cross at each key. Moving the playhead leaves your view alone.

Moving the view by hand leaves the camera view, so a view you have just set up is never taken away by moving the playhead. Keying the camera returns to it, because the camera then is your view. The exception is Auto-key: while it is on, moving the view in camera view moves the camera instead of leaving it.

On the timeline a camera key is one thing even though it sits on up to three tracks: selecting, moving or deleting its position key takes its target and field-of-view keys at that time with it.

The animation is saved in the scene file and the player plays it. A force's travel time cannot be keyed: every moving splat's place along its path is derived from it, so changing it mid-flight would make the whole flow jump.

### Rendering a video

**Export → Video → Render video (.mp4)** renders the whole timeline, start to end, to an H.264 `.mp4`. Choose a size (720p up to 4K, square or vertical), a frame rate and a quality. The frame rate is the timeline's own: changing it in either place changes it in both.

It is a true offline render, not a screen recording: the timeline is stepped one frame at a time at exactly the chosen rate, each frame waits for its depth sort before it is taken, and the canvas is rendered at the chosen size whatever the size of your window. The picture is the animated camera's view; if the camera has no keys, it is wherever the viewport camera is. The grid, gizmos, box outlines and selection highlight are left out. With **Include labels** ticked, pinned labels and labelled boxes (outline, name and description) are drawn into every frame. Forces run on the same stepped clock, so the flow is smooth at any frame rate.

Things to know:

- **Labels are redrawn for the video.** On the page they are HTML over the canvas, which a video cannot hold, so the render draws the same labels into the picture: same typeface, layout and halo. They are sized against the viewport, so they take up the same share of the frame as they do on screen; a taller editor window therefore gives smaller labels in the video.
- The output's shape is the size you choose, not your viewport's, so a vertical render frames the scene differently from what a wide window shows. The vertical field of view is what stays fixed.
- It needs a browser that can encode H.264 through WebCodecs: current Chrome or Edge. The button reports it if the browser cannot.
- For forces, render with the editor on WebGPU (`?device=webgpu`), for the same depth-ordering reason as in the player.
- There is no sound track.

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
| `F` | frame the splat, keeping the view's direction |
| Numpad `1` `3` `7` · `9` | front · right · top view · the opposite side |
| Numpad `5` · `0` | perspective / orthographic · look through the animated camera |
| Numpad `4` `6` `8` `2` · `+` `−` · `.` | orbit 15° (with `Ctrl`: pan) · zoom · frame |
| `Space` | play / pause the timeline |
| `K` · `Shift+K` | key what is being edited · key the camera |
| `Ctrl+A` over the timeline | select every key |
| `Home` | playhead to the start |
| `T` | fold the timeline away |

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

Viewers get buttons for whatever the scene contains: saved viewpoints, labels on/off (`L`), the cut-away on/off (`C`), the flow on/off, reset (`R`) and full screen (`F`). A scene with an animation also gets a play/pause button and a scrubber (`Space`); if the animation moves the camera, taking hold of the view pauses it and the play button hands the camera back.

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
| `autoplay` | scene's, `false` under reduced motion | start the scene's animation by itself |
| `ui` | `true` | built-in controls |
| `label` | scene name | accessible name of the 3D view |
| `device` | `'webgpu'` for scenes with forces, else `'webgl2'` | WebGPU falls back to WebGL 2 |
| `maxPixelRatio` | `2` | cap on device pixel ratio |

Methods: `load()`, `setPose(index | pose)`, `reset()`, `getPose()`, `setSectionsEnabled(bool)`, `setAnnotationsVisible(bool)`, `setForcesEnabled(bool)`, `play()`, `pause()`, `seek(seconds)`, `toggleFullscreen()`, `destroy()`, `on('load' | 'error' | 'progress' | 'pose' | 'state', fn)`. `player.loaded` is a promise for "on screen".

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
  ],
  "animation": {
    "duration": 12, "fps": 24, "loop": true, "autoplay": true,
    "tracks": [
      { "target": "camera.position", "keys": [{ "t": 0, "v": [3.2, 1.4, 3.2] }, { "t": 6, "v": [-3.4, 2.2, 2.4] }] },
      { "target": "force.0.strength", "keys": [{ "t": 0, "v": 5 }, { "t": 6, "v": 70, "ease": "linear" }, { "t": 12, "v": 5 }] }
    ]
  }
}
```

A track's `target` is a path: `splat.position|rotation|scale`, `camera.position|target|fov`, `force.<n>.<property>`, `section.<n>.position|rotation|size`, or `rest.opacity`, where `<n>` counts from 0. A key's `ease` says how its value travels to the next key: `smooth` (the default, a curve through the keys), `linear` or `hold`.

`src` and `poster` resolve relative to the scene file, so a scene and its assets can be moved as a folder. Positions are in world space. A label's `offset` is where its text sits relative to its point on screen, in CSS pixels. `sectionRest` says how the splats outside the boxes are shown; without it they are not drawn. Up to 8 section boxes and 4 forces are applied. Supported splat formats: `.ply`, `.compressed.ply`, `.sog`, and SOG `meta.json` / streamed `lod-meta.json`. Files served from another origin need CORS headers.

## Layout

```
src/core/      scene format · SplatViewer (engine wrapper: device, camera, loading, render-on-demand) · orbit controls
               effects (the per-splat shader hook) · sections · forces · annotations (the label layer)
src/player/    SplatPlayer + <splat-player>, its shadow-DOM styles, the player.html entry
src/editor/    Editor model, per-splat edit state, selection tools, undo history, .ply export, UI panels,
               timeline, view navigation (axis views, the gizmo), key diamonds
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
- The timeline has no curve editor and no zoom: keys are edited as diamonds on a strip the length of the animation. Rotations are interpolated as Euler angles, so key them in steps of less than half a turn.
- A force's own flow runs on a free clock, not on the timeline, so scrubbing moves forces, boxes and the camera but not the individual splats along their paths.
- The player bundle is about 430 kB gzipped, nearly all of it engine. Import it dynamically so it never weighs on pages without a splat.
- `public/samples/knot-clean.sog` was made with `splat-transform` from `knot-clean.ply`; regenerate it if you change the sample script.
- `.spz` is not wired up (the engine's parser needs a separate zstd wasm module).
- Video encoding uses [Mediabunny](https://mediabunny.dev) (MPL-2.0), loaded only when a render starts. It is not part of the player library.
- Not yet tested: touch gestures on real devices, Safari and Firefox, and a real capture with spherical harmonics.
