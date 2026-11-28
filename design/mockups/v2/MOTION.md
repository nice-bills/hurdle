# Motion for Hurdle, from the webdev.teknium.io catalog

webdev.teknium.io ("Uncommon Web") is a catalog of 462 live demos of web libraries. I read every entry (all 23 families) and shortlisted the ones that make a calm fintech app feel alive without changing its look (style C: soft grey, white cards, ink pills, no gradients or slabs).

## Shortlist (6), and what shipped

| Library (catalog demo) | Why it fits Hurdle | Where it goes | Shipped |
| --- | --- | --- | --- |
| **NumberFlow** `@number-flow/react@0.6.2` (Type: "Voyager 1 live telemetry") | Hurdle is a numbers product. Digits that roll, instead of swapping, make live data feel live, and it keeps Intl formatting | Every headline number (`<Num>`, stat cards, NAV, vs par, bond %, replay verdicts and day), plus all epoch countdowns, which tick digit by digit | Yes |
| **Motion** `motion@14.12.0` (Motion: "Interruptible spring field") | Springs that can be interrupted, layout animation, and exit animation are things CSS can't do | Sliding pill under the active header link and phone tab; tx status label crossfade; replay "fired" callout springs in; play/pause icon swap | Yes |
| **Paper Shaders** `@paper-design/shaders-react@0.0.82` (Dither: "Live dithering shader") | An ordered-dither field is texture, not a gradient. Tinted to the par green at low alpha, it reads as "the pool, moving" | Behind the home hero only, drifting slowly toward the pointer (spring). Off on phones and under reduced motion; pauses off screen | Yes |
| **Rough Notation** `rough-notation@0.5.1` (Type: "An editor's red pen") | One hand-drawn mark puts the claim a judge should read first | Underlines "beat par" in the hero headline; draws a box around "Never below par in 166 settlements" when a replay finishes | Yes |
| **AutoAnimate** `@formkit/auto-animate@0.10.2` (Motion: "Self-animating live leaderboard") | One line, and a new settlement or keeper run slides in instead of popping | Settle history list and keeper runs on the vault page | Yes |
| Liveline (Kits: "Live crypto ticker terminal") | Real-time canvas line charts | Would replace ParChart | No: it would change chart logic. The same feel is done in ParChart with a CSS clip-path draw-in and a pulsing latest point |

Rejected on purpose: Vanta, WebGL Fluid, ShaderGradient and Mesh Gradient (gradient slabs, off style); canvas-confetti and party.js (a deposit is money, not a party); Lenis smooth scroll (hijacks native scroll on phones); cursor followers and magnetic type (decoration on a data app); SSGOI page transitions (a CSS enter animation is cheaper and needs no router coupling).

## Our own CSS (no library)
- Page enter: each route fades and rises 10 px in 320 ms (`app/template.tsx`).
- The hero headline rises in word by word (40 ms stagger). The home screens, vault cards and stat cards stagger in at 60 ms.
- Charts draw left to right once (clip-path, 1.1 s ease-in-out) and redraw on a scenario or view switch. The latest point breathes.
- The bond meter fills from the left on first paint.
- Tx status: a 4-step bar (Check → Sign → Onchain → Done) fills as the phase moves, and the confirmed check draws itself.
- Press states use scale 0.96–0.99. Hover lifts are gated to `(hover: hover) and (pointer: fine)`. The segmented thumb uses the iOS drawer curve. The swap flip icon turns 180° on each flip.
- Replay: while it plays, the header and verdict cards dim to 45%, so the chart and live readouts lead.

## Rules kept
- Only transform and opacity move. Clip-path is used for the one chart reveal and stroke-dashoffset for the check.
- One-shot entrances use `backwards` fill, so nothing keeps a transform after it lands.
- `prefers-reduced-motion` is respected everywhere:
  - The global CSS rule collapses animations.
  - `MotionConfig reducedMotion="user"` covers Motion.
  - NumberFlow respects the preference by default.
  - Paper Shaders gets speed 0.
  - Rough Notation draws without animation.
- Numbers keep their exact text in a visually hidden copy for screen readers and tests. The rolling digits are `aria-hidden`.
- Logic is untouched: only markup and styles changed.

## Videos
`build/motion-{home,replay,vault}-{1440,390}.mp4` (headless Chromium, light theme).
