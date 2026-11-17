"""Exact offchain par vs the on-chain replay's par (definition of done, item 1).

Mirrors test/Replay.t.sol: walk the swap CSV, settle when t >= nextSettle (before that row's swap),
accrue fee per unit L exactly as v4 does for a swap-to-price (fee = in * f / (1 - f)), and compound
the full-range benchmark between settlements. Prices are spot at settlement; on-chain uses the
hook's TWAP, so a small endpoint difference is expected and reported.
Usage: python3 data/par_check.py data/weeks/2026-10-31.csv demo/out/range-week.csv [--twap]
--twap values each settlement at the replay's TWAP (as on-chain) instead of spot.
Fee credit per epoch is capped like HurdleVault.benchmark: fees <= start value * 3.0 * elapsed / 365d
(MAX_FEE_APR_BPS = 300% APR); the number of capped epochs is reported.
"""
import csv, sys
from decimal import Decimal as D, getcontext
getcontext().prec = 50

swaps_csv, replay_csv = sys.argv[1], sys.argv[2]
F = D(500) / D(1_000_000)
Q96 = D(2) ** 96
EPOCH = 3600
MAX_FEE_APR = D(3)  # 300% APR
YEAR = 365 * 86400

rep = list(csv.DictReader(open(replay_csv)))
onchain = [(int(r["t"]), D(int(r["par"])) / D(10) ** 18) for r in rep]
use_twap = "--twap" in sys.argv
twap = {int(r["t"]): D(int(r["twapSqrtPriceX96"])) / Q96 for r in rep}
rows = csv.DictReader(open(swaps_csv))
first = next(rows)
s = D(int(first["sqrtPriceX96"])) / Q96
t0 = int(first["timestamp"])

par, s0, f0, f1 = D(1), (twap[t0] if use_twap else s), D(0), D(0)
last, capped = t0, 0
offchain = [(t0, par)]
next_settle = t0 + EPOCH
for r in rows:
    t = int(r["timestamp"])
    if t >= next_settle:
        # full range: value per L = 2 s; fees per L valued at the end price
        se = twap[t] if use_twap else s  # settlement price
        fees = f0 * se * se + f1  # per L, in token1
        cap = 2 * s0 * MAX_FEE_APR * (t - last) / YEAR
        if fees > cap:
            fees, capped = cap, capped + 1
        par *= (2 * se + fees) / (2 * s0)
        last = t
        offchain.append((t, par))
        s0, f0, f1 = se, D(0), D(0)
        next_settle = t + EPOCH
    s1 = D(int(r["sqrtPriceX96"])) / Q96
    if s1 > s:  # token1 in
        f1 += (s1 - s) * F / (1 - F)
    elif s1 < s:  # token0 in
        f0 += (1 / s1 - 1 / s) * F / (1 - F)
    s = s1

n = min(len(onchain), len(offchain))
assert all(onchain[i][0] == offchain[i][0] for i in range(n)), "settlement timestamps differ"
diffs = [abs(onchain[i][1] - offchain[i][1]) * 10_000 for i in range(n)]
print(f"{swaps_csv}: {n} settlements")
print(f"final par  on-chain {onchain[n-1][1]:.6f}  offchain {offchain[n-1][1]:.6f}  diff {diffs[-1]:.3f} bp")
print(f"max |diff| over all settlements {max(diffs):.3f} bp, median {sorted(diffs)[n//2]:.3f} bp")
print(f"epochs at the fee cap: {capped} of {n - 1}")
