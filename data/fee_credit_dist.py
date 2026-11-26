"""Distribution of par's UNCAPPED hourly fee credit as an APR on the epoch's starting NAV.

Same walk as data/par_check.py (spot prices, hourly settle when t >= next_settle, v4 swap-to-price fee
accrual). Prints max / p99 / median per week and overall, plus the count of epochs above given caps.
Usage: python3 -I data/fee_credit_dist.py data/weeks/*.csv
"""
import csv, sys
from decimal import Decimal as D, getcontext
getcontext().prec = 40
F = D(500) / D(1_000_000); Q96 = D(2) ** 96; EPOCH = 3600; YEAR = 365 * 86400

def week(path):
    rows = csv.DictReader(open(path))
    first = next(rows)
    s = D(int(first["sqrtPriceX96"])) / Q96
    last = int(first["timestamp"]); s0 = s; f0 = f1 = D(0); nxt = last + EPOCH; out = []
    for r in rows:
        t = int(r["timestamp"])
        if t >= nxt:
            fees = f0 * s * s + f1
            out.append(float(fees / (2 * s0) * YEAR / (t - last)))  # fee credit / NAV, annualized
            last, s0, f0, f1, nxt = t, s, D(0), D(0), t + EPOCH
        s1 = D(int(r["sqrtPriceX96"])) / Q96
        if s1 > s: f1 += (s1 - s) * F / (1 - F)
        elif s1 < s: f0 += (1 / s1 - 1 / s) * F / (1 - F)
        s = s1
    return out

def pct(v, p):
    v = sorted(v); i = (len(v) - 1) * p; lo = int(i)
    return v[lo] + (v[min(lo + 1, len(v) - 1)] - v[lo]) * (i - lo)

allv = []
for p in sys.argv[1:]:
    v = week(p); allv += v
    print(f"{p}: n={len(v)} max={max(v)*100:.1f}% p99={pct(v,.99)*100:.1f}% median={pct(v,.5)*100:.1f}%")
print(f"ALL: n={len(allv)} max={max(allv)*100:.1f}% p99={pct(allv,.99)*100:.1f}% p95={pct(allv,.95)*100:.1f}% median={pct(allv,.5)*100:.1f}%")
for cap in (0.8, 1, 1.5, 2, 3):
    print(f"epochs above {cap*100:.0f}% APR: {sum(x > cap for x in allv)}")
