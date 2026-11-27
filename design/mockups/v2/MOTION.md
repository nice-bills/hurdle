# What makes webdev.teknium.io feel alive

Studied 2026-11-27 (page source, CSS and runtime JS).

- **A living background that answers the pointer.** The hero is a 1-bit Bayer dither field drawn on a canvas, always slowly drifting (sine fields at ~30 fps). A ripple follows the cursor with damping (`m += (target - m) * 0.06`), so it trails instead of snapping. It pauses when off-screen or the tab is hidden, and it is removed entirely under `prefers-reduced-motion`.
- **Big numbers up front.** Four large serif stats (462 / 23 / 425 / 0) sit under the headline, the first thing you read after the title. Odometer-style rolling counters appear across the demos.
- **Nothing pops in hard.** Live demo frames fade in (`opacity 0.35s`) over a desaturated poster, so swaps look like a dissolve, not a flash.
- **Loading has a heartbeat.** A loading card shows a small blue dot pulsing (`1s ease infinite`, opacity only), so the page never looks frozen.
- **Navigation follows you.** The sticky section strip highlights the section in view (IntersectionObserver) and smooth-scrolls the active pill to the centre. It moves only the strip, never the page.
- **Quiet, fast hovers.** Pills, tags and links change only colour and border, in 150 ms. Nothing jumps or grows, so a dense page stays calm.
- **Motion is budgeted.** Demos start only after 300 ms of dwell; at most 3 run at once (1 on touch), and the farthest are unloaded first. Fast scrolling starts nothing, so it never janks.
- **Self-drawing details.** Line icons draw their own stroke, and specimen boards stagger in. Small, one-shot "drawn by hand" moments rather than constant motion.

## What Hurdle takes from it

- Hero: a calm, pointer-trailing ambient field (light dither dots, theme-coloured), off under reduced motion; headline reveal; count-up stats.
- Charts draw their lines once on first view; the latest point breathes.
- Loading and live states pulse with opacity only.
- Indicators (segmented thumb, bottom nav) slide rather than jump; hovers stay colour-only and fast; presses scale 0.97.
- Everything is one-shot on first view and is skipped when off-screen or under reduced motion.
