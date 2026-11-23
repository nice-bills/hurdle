# Hurdle demo video script (about 84 s, 1280x720, no voice, captions only)

Recorded headless from https://hurdle-app.onrender.com by `record.cjs` (same folder). No wallet, no transactions.

| # | Time | Page | Caption |
|---|---|---|---|
| 1 | 0-6 s | `/` landing | "Curators run your liquidity. But can you tell if they beat a passive LP?" |
| 2 | 6-14 s | `/` chart | "Hurdle sets par: what a passive full-range LP earned. The pool computes it. No oracle." |
| 3 | 14-22 s | `/replay` | "Beat par: the curator earns carry. Miss par: the bond pays you the shortfall." |
| 4 | 22-32 s | `/vaults` | "Live on Unichain Sepolia. Patient and Chaser are healthy, bonds refilled, deposits open each epoch." |
| 5 | 32-41 s | `/vaults/<Reckless>` | "Reckless was built to fail. Fired on-chain 2026-11-22 16:39 UTC. The vault now parks full range." |
| 6 | 41-49 s | `/vaults` v3 section | "Earlier v3 Patient was also fired on-chain, 2026-11-22 11:02 UTC." |
| 7 | 49-60 s | `/replay` (ETH -14% week) | "Real swaps, real weeks. Depositors were never below par at any of 166 settlements." |
| 8 | 60-70 s | `/vaults/<Patient>` deposit panel | "Deposit in kind in the first 5 minutes of each epoch. Your shares are covered by the bond." |
| 9 | 70-84 s | `/integrate` | "Builders: one factory, one hook, a few calls. Read the docs." |

Timings are approximate (page loads vary). Recorded by CDP screencast frames encoded with ffmpeg (Playwright's own video recorder wrote no file with the local Chromium build).
