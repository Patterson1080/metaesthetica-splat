# Embedding the player in the Metaesthetica website

Status: a plan. Nothing on the website has been changed. This note records how the player would fit the site as it stands, so the integration can be done in one pass when it is wanted.

## The site, as far as the player is concerned

- A client-rendered single-page app: Vite, React, strict TypeScript, Tailwind. The same toolchain as this project, so the player's types and module format drop in.
- Static hosting on GitHub Pages with a custom domain; no backend. The player needs nothing more than static files.
- Content is typed data files rendered by page components. Media is referenced through a small base-path helper.
- Two existing media patterns matter here:
  - a lazy video component that only fetches when it nears the viewport, pauses off-screen, and does not autoplay under reduced motion;
  - a full-screen lightbox built on a native modal `<dialog>`, always dark, stepping through a gallery's items with the arrow keys.
- Light, dark and auto themes from CSS custom properties (paper, ink, muted, rule, surface, and one accent used for focus and selection).
- The whole site is currently about 93 kB of JavaScript gzipped, with no route splitting, by design.

The player was built to behave like the lazy video component: nothing loads until it is near the viewport or asked for, it stops rendering off-screen, and it holds still under reduced motion.

## How it fits

### One component

A thin wrapper is the only new component the site needs. It creates the player in an effect and destroys it on cleanup; `destroy()` is safe mid-load and when called twice, so React StrictMode's double mount is fine.

```tsx
import { useEffect, useRef } from 'react'
import type { SplatPlayer, SplatPlayerOptions } from 'splat-engine/player'

export default function SplatViewer({ className, ...options }: SplatPlayerOptions & { className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let player: SplatPlayer | undefined
    let cancelled = false
    // dynamic import: the engine is only downloaded by visitors who reach a splat
    import('splat-engine/player').then(({ SplatPlayer }) => {
      if (!cancelled && ref.current) player = new SplatPlayer(ref.current, options)
    })
    return () => {
      cancelled = true
      player?.destroy()
    }
  }, [options.scene, options.src])
  // the player orbits on the arrow keys; keep them from also stepping the lightbox
  return <div ref={ref} className={className} onKeyDown={(e) => e.key.startsWith('Arrow') && e.stopPropagation()} />
}
```

### Bundle size: load it dynamically

The player is about 430 kB gzipped, nearly all of it the engine: more than four times the site's current total. It must be loaded with a dynamic `import()` as above. That makes it the site's first split chunk, fetched only on pages that show a splat and only once one is about to be seen.

### Data model

Gallery items are currently an image, a video or an embedded video. A splat is a fourth kind: a scene URL plus a poster image. The poster is what the grid tile shows and what crawlers and social cards see.

### Tile in the grid, player in the lightbox

The natural placement is a poster tile in the gallery that opens the live player in the existing lightbox:

- only one WebGL context is alive at a time, however many splats a page lists (browsers cap contexts, phones tightly);
- the lightbox is already a dark full-screen stage, which is where splats look right;
- in the lightbox the player should use `interaction: 'always'`, since there is no page scroll to protect.

An inline player in the page flow also works (`interaction: 'activate'`, the default, leaves the scroll wheel to the page until the visitor clicks in). The demo page in this repository shows both.

One thing to handle: the lightbox steps between items on the left and right arrow keys, and the player orbits on the same keys when its canvas has focus. The wrapper should stop arrow-key events from bubbling out of the player while it is focused.

### Theme

- The player's controls and labels live in a shadow root, so the site's CSS reset and utility classes cannot disturb them. The controls inherit the page font. Labels are set in Avenir by default, which only Apple systems carry; to keep them in the site's own face (or to serve Avenir as a licensed webfont) set `--splat-label-font`.
- Colors come in through custom properties: map the site's ink to `--splat-fg` and its accent to `--splat-accent`. Labels take `--splat-label-color`.
- Keep the stage black in both themes, as the lightbox already does. Captures are trained against dark backgrounds and their soft edges look wrong on white. A transparent canvas is supported for the cases that want it.

### Section boxes, labels and forces on the site

- **Labels** are real text with no background: a title in tracked capitals over a ticked hairline, body text beneath. They are in the accessibility tree and visitors can hide them. A section box can carry a label of its own, which presents the box as a named component of the work.
- **Section boxes** and **forces** are part of the scene file, so a work page needs nothing extra to show a component singled out (the rest faded or hidden) or a flowing version: it points at a different scene file for the same splat.
- **Forces** animate continuously, so a player showing them keeps rendering while it is on screen (it still stops off-screen). They start stilled for visitors who ask for reduced motion. Scenes with forces ask for WebGPU, where moving splats are layered correctly, and fall back to WebGL 2, where the flow runs but splats carried in front of others can be drawn behind them.

## Assets

- Publish `.sog`, never `.ply`. Keep the `.ply` out of the website repository the way full-size originals already are.
- A scene is a small folder: `name.scene.json`, `name.sog`, `name.webp` (poster). Paths inside the scene file are relative to it, so the folder can sit anywhere under the site's media directory and still resolve through the base-path helper.
- Size is the constraint. As a rough guide, expect something like 10–40 MB per real capture as `.sog` (an estimate, not a measurement; the procedural sample here is 0.8 MB because it has no spherical harmonics). The website repository already carries about 50 MB of media, GitHub rejects single files over 100 MB, and Pages sites are capped at 1 GB. A few splats fit in the repository; a growing collection belongs on external storage, which needs CORS headers for the site's origin.
- For large captures use `load: 'click'`: only the poster is fetched until the visitor asks for the 3D view.
- Splats under the site's media directory inherit whatever crawler rules already apply there.
- The site discourages casual saving of images and video. A splat file is as downloadable as any other static asset; the player suppresses the context menu on its canvas, and that is all it can honestly do.

## Getting the library into the site

| Option | Effort | Notes |
| --- | --- | --- |
| Copy `dist-lib/splat-player.js` and `dist-lib/types/` into the site | none in CI | Simplest start. Updating is a manual copy. |
| Git dependency on this repository | small | Needs `dist-lib` committed or built on install. No extra credentials while this repository is public. |
| Publish to npm | moderate | Worth it once the player changes often or other sites use it. |

## Search and accessibility

- A canvas is invisible to crawlers and to link previews. The poster image, the caption and the page's own text carry the content. A new page for a work needs an entry wherever the site lists its routes for prerendered metadata and the sitemap.
- The player has keyboard orbit and zoom, labelled controls, a live status region, and a text description of its shortcuts.

## Steps, when the time comes

1. Add the library (start with the copy option).
2. Add the wrapper component, with the arrow-key guard.
3. Extend the gallery item type with a splat kind; render the poster in the grid and the player in the lightbox.
4. Map the theme properties.
5. Export one capture end to end (editor → `.sog` → scene folder) and check it on a phone before adding more.

## Not yet checked

Touch gestures on real devices, Safari and Firefox, and a real capture with spherical harmonics have not been tested. The first integration should include all three.
