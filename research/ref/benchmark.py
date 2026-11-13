"""Reference check: passive full-range LP vs HODL, per unit liquidity.

Claim: over any price path s0 -> ... -> s1 (s = sqrtPrice, P = s^2, token1 numeraire),
  value(full-range L) - value(HODL initial inventory) = fees - L*(s1-s0)^2/s0
i.e. path-independent except fees, so the hook needs only (sqrtPrice, feeGrowthGlobal)
snapshots at epoch start/end. Fees per L = delta feeGrowthGlobal (what any in-range L earns).
"""
import random

def full_range_inventory(L, s):
    return L / s, L * s  # x (token0), y (token1)

def check(trials=2000, steps=200, seed=1):
    rng = random.Random(seed)
    worst = 0.0
    for _ in range(trials):
        L = rng.uniform(1, 1e6)
        s = s0 = rng.uniform(0.1, 100)
        x0, y0 = full_range_inventory(L, s0)
        fees1 = 0.0  # fee income valued in token1 at end price (accumulated in both tokens)
        fg0 = fg1 = 0.0  # fee growth per unit L
        fee = 0.003
        for _ in range(steps):
            s_new = s * rng.uniform(0.98, 1.02)
            # swap moves price; in-range LP inventory follows the curve, swapper pays fee on input
            if s_new > s:   # token1 in
                fg1 += fee * (s_new - s)            # dy per L = s_new - s
            else:           # token0 in
                fg0 += fee * (1 / s_new - 1 / s)    # dx per L
            s = s_new
        s1 = s
        x1, y1 = full_range_inventory(L, s1)
        P1 = s1 * s1
        lp = x1 * P1 + y1 + L * (fg0 * P1 + fg1)
        hodl = x0 * P1 + y0
        predicted = L * (fg0 * P1 + fg1) - L * (s1 - s0) ** 2 / s0
        err = abs((lp - hodl) - predicted) / hodl
        worst = max(worst, err)
    return worst

if __name__ == "__main__":
    w = check()
    print(f"worst relative error: {w:.3e}")
    assert w < 1e-9, w
    print("PASS: benchmark = fees - L(s1-s0)^2/s0, path-independent")
