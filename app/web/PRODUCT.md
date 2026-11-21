# Product

## Register

product (the `/` landing is the one brand-register surface)

## Users

- Depositors (LPs) deciding whether to hand capital to an onchain liquidity curator, then checking on it.
- Curators running a vault: posting bond, re-ranging, watching the bond floor.
- Keepers and integrators: who settles, what the ABI looks like.
- Hackathon judges (UHI11, "Active Management and Curated Liquidity"): need the mechanism and live proof in under a minute.

## Product Purpose

Hurdle is a Uniswap v4 hook + vault where a curator guarantees depositors at least par (the return of a passive
full-range LP, computed by the pool itself), pays misses from a posted bond and earns carry only above par.
The app makes that contract legible and usable on Unichain Sepolia: see every vault against its par, act on it.
Success: a depositor can tell in one glance whether a curator cleared the bar, and can deposit, settle or
curate without reading Solidity.

## Brand Personality

Exact, athletic, fair. A scoreboard, not a casino. Numbers first, explanations one tap away, no hype.

## Anti-references

- Generic DeFi dashboards: navy + neon gradients, glass cards, giant APY numbers.
- Terminal-cosplay dark mode with mono everywhere.
- Template SaaS landing pages (hero metric + three icon cards).

## Design Principles

1. The bar is the brand: par is always drawn the same way (the amber hurdle bar), everything is measured against it.
2. Show the proof, not the claim: live chain numbers and real-swap replays instead of adjectives.
3. Every disabled button says why, in the contract's own terms.
4. Same vocabulary everywhere: ACTIVE / FROZEN / FIRED, floor and fire line, par.

## Accessibility & Inclusion

WCAG 2.2 AA contrast, keyboard reachable, visible focus, status never color-only (text + icon), reduced motion respected,
works at 390 px.
