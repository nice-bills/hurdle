# Changelog v3 → v4 (round 4)

Commits 9909e0e → HEAD. By round-3 item (Opus 7, Sonnet 9, Luna 8) plus Luna v4 (8) and two audits.

## Contracts (live as v5)

| Item | Change | Where / test |
|---|---|---|
| Fired vaults not really parked (Opus 1) | Pool depth added (`script/AddDepth.s.sol`); keeper steps the park until `AlreadyParked`; app's parked check mirrors the contract (≤2% idle). | `app/worker/src/keeper.ts`, `app/web/src/lib/server/data.ts` |
| Fired-vault deposits depend on the fired curator (Opus 2) | Fired AND parked vaults skip the deficit/capacity gates; fired but not parked refuse (`NotParked`). | `test/V4Features.t.sol`, `test/audit/Audit3Regression.t.sol` |
| Wash-trade fee credit (Luna v3 1, v4 1) | Fee-credit cap calibrated to real flow: 80% APR (2x the replay p99, never binds on the replays). Bond drain ≤ 0.91 bp NAV/h, and only for an out-of-range vault; an in-range vault earns ~168x its par fee credit from the same wash. | `research/fee-cap.md`, `test/FeeCapAttack.t.sol` |
| Accounting unaudited (Luna v3 2) | Independent accounting audit (`research/audit3-accounting.md`): deficit owed by depositor shares only (noise around par now neutral); fired-unparked deposits refused; implicit settles pay the bounty to the caller. 11 new invariants + noise-neutrality fuzz. | `test/invariant/`, `test/audit/Audit3Regression.t.sol`, `NoiseNeutrality.t.sol` |
| Covered-settle definition (Luna v4 2) | Contract already grosses the bond payment up by t/(t−x); depositors are whole in the same settlement whenever the bond covers `owed·(t−b)/(t−x)`. Handler + README use that definition. | `test/audit/ShortfallPayout.t.sol` |
| Docs vs code on fee cap (Opus 3) | README/IDEA/NatSpec state the 80% cap and why a one-epoch clamp was rejected. | README Limits |

## Alignment audit (research/council/v3-alignment.md, 25 findings, all fixed in 8efea1b)

App parked check, /integrate snippets, curator-bot gates (deposit window, RebalanceIncomplete), stale docs/counts, e2e UI-smoke flake.

## Live (Unichain Sepolia) — v5

- Redeployed the audited contracts (14acf9f) as v5; token order flipped (currency0 = mWETH, NAV/bond in mUSDC). App, worker and keeper read token order from the deployment.
- Curator bot (worker, curator key) re-centres Patient and Chaser near their range edges (Opus 5: "no curator skill shown live"). Reckless is unmanaged by design.
- Scripted −593-tick move 2026-11-26 15:00 UTC (rehearsed on a fork): at the 15:58 settle Reckless missed par, its bond paid, it was fired and parked full range; Patient and Chaser paid 50 / 40 mUSDC and stayed in charge; the curator refilled both bonds (deficit 0, deposits open). v4 kept read-only as the earlier deployment.

## Not done

- Demo video and UI redesign: deliberately after this review loop.
- External human audit (model audits only: audit2, audit3, alignment).
