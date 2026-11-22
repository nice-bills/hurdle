# Changelog v1 → v2

What changed since the v1 council round (commit 3f6c6bc), by v1 item. Commits: 50f5c21 onward.

## Contracts

| v1 item | Change | Where / test |
|---|---|---|
| Deposit liveness: a third-party settle closed the deposit block for a whole epoch (Opus 6, Sonnet 1) | Deposits are open for the first `DEPOSIT_WINDOW` = 5 min of each epoch. A deposit re-baselines par to its own block (settles the gap so far; same epoch clock and rebalance count), so a newcomer neither pays for nor collects earlier performance. | `HurdleVault.deposit`; `test/V2Features.t.sol` (`test_windowClosesAt301AndReopensNextEpoch`, `test_rebaselineKeepsEpochClockAndRebalanceCount`, `test_newcomerFairness_vaultAhead`, `test_newcomerFairness_vaultBehind`), `test_depositAfterThirdPartySettle` |
| Oracle trust: any hook accepted (DeepSeek 5, Sonnet 5, GLM 3) | `HurdleVaultFactory` creates vaults only on pools whose hook is the canonical `HurdleHook` and records them in `isVault`. Live vaults are deployed through it. | `src/HurdleVaultFactory.sol`; `test_factory`; `script/DeployVaults.s.sol` |
| Post-fire bond stranded (DeepSeek 3) | `reclaimBond()`: after firing, once the vault is parked full range and one epoch has passed, the curator takes back the remaining bond tokens and bond shares. | `test_reclaimBond_guards`, `test_reclaimBond_notParkedThenSuccess` |
| Unrewarded settle, long epochs widen the wash residual (DeepSeek 4, part) | `settle()` by a third party on schedule earns 5% of that epoch's carry (`SETTLER_BOUNTY_BPS`), minted out of the curator's carry. Implicit settles (deposit, withdraw, rebalance) pay none. The realized-APR fee cap was **not** done; the cross-block wash residual stays documented in Limits. | `test/V3Features.t.sol`: `test_settlerBountyFromCarryOnly`, `test_noBountyOnImplicitSettle` |
| TWAP lag freezes the curator (DeepSeek 8, Sonnet 6) | Bonded curator rebalances gate on a 10-min TWAP (spot, block-open and 10-min within 50 ticks; 10- and 30-min within 200). The swap stays within 50 ticks of the 30-min TWAP too (added after a Codex security review found the fast gate could trade 5 × dev from the mark), so the bond bound still holds. Fired-vault parks keep the strict 30-min gate (a replay showed a loose park cost depositors 0.29% right after firing). Refused re-centers: 24 → 19 (range week), 19 → 12 (down week). | `_checkedRebalanceTick`, `_swapToRatio`; `test_rebalanceMinutesAfterRealMove`, `test_rebalanceRevertsWhenShortAndLongTwapDisagree` |
| No quotes for in-kind deposits; shares not ERC20 (DeepSeek 6) | `previewDeposit` (never under-quotes: +2 wei per token) and `previewWithdraw`. Shares stay non-transferable on purpose (the shortfall math must know which shares are the curator's); documented in NatSpec and Limits. | `test_previews` |
| Par endogenous to the vault's own depth (Opus 7) | Measured, documented: at 85% of in-range liquidity par undercounts a real full-range LP by 23 bp over the test, in the curator's favour. | `test_endogenousPar` (logs numbers), README Limits |
| Comment accuracy (DeepSeek nits) | TWAP-valuation direction, post-fire park cost, ring span wording fixed. | `src/` NatSpec |

## Tests

- `test/VaultFixture.sol`: shared fixture; `Audit2Regression` no longer re-runs the 31 vault tests (Sonnet nit).
- `test/invariant/`: stateful handler suite (deposit, withdraw, swaps, warps, settle, rebalance, postBond,
  reclaimBond) with share-sum, bond, deficit, depositor ≥ par when covered, fired-monotonic and liveness
  invariants (Sonnet 4, DeepSeek 7).
- Replay curator now tops up its bond when a re-center is refused for `BondBelowFloor` (Sonnet 6).

## Results (current code, real swaps)

README "Results on real swaps". Depositors never below par at any of 166 hourly settlements, both weeks;
on-chain par vs independent offchain reference: max 0.001 bp.

## Docs

- README: results table in USD (same convention as the UI), v2/v3 mechanics, Limits rewritten (deposit
  window, 10-min gate, endogenous par, non-transferable shares, bounty coverage).
- IDEA.md: par described as what it is (closed form at settlement, not per-block hook work), honest gas
  (~40k steady on the first swap of a block, ~58k isolated; target met only in steady state), deploy
  done, submission text corrected (Opus 5, GLM 2, Sonnet 3).

## UI (demo/ui)

Real data only (mocks removed). Two bond levels (2% floor freezes; a miss below 1% fires), fire reason next
to the "≥ par" badge, banner "Miss left bond below ½ floor → curator fired, vault parked passive",
390 px layout, live panel reading the Sepolia vaults over JSON-RPC (Opus 3, Sonnet 2/3, DeepSeek 2).

## Full dApp (new)

- `app/web` (Next.js, wagmi/viem): https://hurdle-app.onrender.com. Vault explorer and vault pages (NAV vs par per
  settlement, bond meter, position vs tick, events, keeper runs), deposit/withdraw with previews, settle, curator
  console (create via factory, post bond, rebalance, reclaim), swap, real-week replays, `/integrate` developer docs.
  Decoded revert reasons. Tested headless at 1280/390 px, light/dark, zero console errors.
- `app/worker`: indexer (all factory/vault events → Postgres) + 24/7 keeper (own wallet), `/healthz`.
- `e2e.sh`: one command runs build/size, all tests incl. invariants, both replays, par check, UI data, UI smoke.

## Live deployment

Redeployed v3 (hook, factory, two vaults) on Unichain Sepolia. Two scripted −9.5% moves: both bonds paid shortfalls
on-chain; Patient was fired at 2026-11-22 11:02 UTC and parked by the keeper; its bond ran out, so its depositors
end 0.77% below par (README).

## Not done

- Demo video (in progress).
- Gas under 40k in isolation.
- Realized-APR fee cap.
