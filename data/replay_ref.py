"""Replay reference: closed-form passive-LP benchmark + two toy strategies
over a real week of ETH/USDC 0.05% swaps (data/swaps.csv from fetch_swaps.py).

POOL FACTS (verified via eth_call on the pool + event cross-checks):
  token0 = USDC (6 dec), token1 = WETH (18 dec), fee = 0.05%.
  P = s^2 where s = sqrtPriceX96 / 2^96  =>  P = WETH_raw per USDC_raw
  (price of token0 in token1, raw/raw). Human ETH price = 1e12 / P  [USDC/WETH].
  Every sampled event satisfies tick = ln(P)/ln(1.0001) and
  |amount1/amount0| ~ price, so the v3 Swap decoding is verified on the data.

MATH (research/ref/benchmark.py; infinitesimal LP of arXiv 2609.37963):
  The reference identity is written in the TOKEN1 numeraire (here: WETH):
    value(full-range L) - value(HODL initial inventory)
        = fees(token1-valued) - L * (s1 - s0)^2 / s0
  path-independent except fees: an epoch needs only (sqrtPrice, feeGrowth)
  snapshots at start/end. Fees per unit of in-range pool liquidity L_pool:
    token0 (USDC) in:  fg0 += 0.0005 * amount0 / L_pool    [USDC-raw per L]
    token1 (WETH) in:  fg1 += 0.0005 * amount1 / L_pool    [WETH-raw per L]
  (For small moves amount1 ~ L_pool*(s1-s0), amount0 ~ L_pool*(1/s1-1/s0):
  the swap-input-volume approximation of the fee term.)
  Reported per unit L in human USDC, with every WETH term converted at the
  period-END price (single end-of-period valuation, like the identity itself):
    fees/L  = fg0/1e6 + fg1 / (P_end * 1e6)
    IL/L    = -(s1-s0)^2/s0 / (P_end * 1e6)
  IL is NOT additive across days: sum(daily IL) != weekly IL between week
  endpoints. Fees ARE additive; both views are shown.

TOY STRATEGIES, same fixed capital D (default $1M), simulated swap by swap:
  Patient: static range +-10% around the week-start price, never moved.
  Chaser:  range +-2% around its center; whenever price exits the range it
           re-centers at the current price: inventory is traded into the fresh
           shape (value-preserving at the market price), paying
           0.05% pool fee + 0.10% slippage on the traded notional, and the
           liquidity is re-scaled so capital is preserved.
  A v3 position's inventories are CLOSED-FORM in the current price
  (composition() below), so no incremental bookkeeping is needed: P&L =
  closed-form value change + fees earned while in range - rebalance costs.
  Fees are shared pro-rata: our slice = L_pos / L_pool (the event's in-range
  liquidity) while our range covers the current price.

All arithmetic in RAW token units (USDC 1e6, WETH 1e18); humanize only for
output. Event semantics: positive amount = token the pool RECEIVED.

Rerun:  python3 data/replay_ref.py
"""
import csv
import gzip
import json
import math
import os
import time

HERE = os.path.dirname(os.path.abspath(__file__))

FEE_RATE = 0.0005                      # 0.05% tier
Q96 = float(1 << 96)
REBAL_COST_RATE = 0.0005 + 0.0010      # pool fee + slippage on a rebalancing swap
CAPITAL_USDC = 1_000_000.0             # notional for the toy strategies

CSV_PATH = os.path.join(HERE, "swaps.csv")
if not os.path.exists(CSV_PATH) and os.path.exists(CSV_PATH + ".gz"):
    CSV_PATH += ".gz"


def day_str(ts):
    return time.strftime("%Y-%m-%d", time.gmtime(ts))


def load_swaps():
    """-> list of dicts: day, block, amount0/1 (raw ints), s (float), L_pool."""
    opener = gzip.open if CSV_PATH.endswith(".gz") else open
    rows = []
    with opener(CSV_PATH, "rt") as f:
        for r in csv.DictReader(f):
            rows.append({
                "day": day_str(int(r["timestamp"])),
                "block": int(r["block"]),
                "amount0": int(r["amount0"]),
                "amount1": int(r["amount1"]),
                "s": int(r["sqrtPriceX96"]) / Q96,
                "L": int(r["liquidity"]),
            })
    return rows


# ------------------------------------------------------------- unit helpers

def P(s):
    """WETH_raw per USDC_raw (price of token0 in token1, raw/raw)."""
    return s * s


def eth_price_human(s):
    """USDC per WETH."""
    return 1e12 / (s * s)


def usdc_human(usdc_raw):
    return usdc_raw / 1e6


def weth_to_usdc_raw(weth_raw, s):
    """USDC_raw value of weth_raw at sqrt price s (1 WETH_raw = 1/P USDC_raw)."""
    return weth_raw / P(s)


def input_token(amount0, amount1):
    """Token the swap sold INTO the pool (event: positive = pool receives)."""
    if amount0 > 0 and amount1 <= 0:
        return "usdc"
    if amount1 > 0 and amount0 <= 0:
        return "weth"
    return None


# ------------------------------------------------------- position primitives

def shape_weth_per_L(a, b, s):
    """Position value per unit liquidity in WETH_raw at price s, range [a,b]."""
    if s <= a:
        return (1.0 / a - 1.0 / b) * s * s        # all token0 (USDC)
    if s >= b:
        return b - a                               # all token1 (WETH)
    return (1.0 / s - 1.0 / b) * s * s + (s - a)


def shape_usdc_per_L(a, b, s):
    """Same in USDC_raw."""
    return shape_weth_per_L(a, b, s) / P(s)


def composition(L, a, b, s):
    """Real inventories at price s: (x USDC_raw, y WETH_raw)."""
    if s <= a:
        return (L * (1.0 / a - 1.0 / b), 0.0)
    if s >= b:
        return (0.0, L * (b - a))
    return (L * (1.0 / s - 1.0 / b), L * (s - a))


def usdc_value(L, a, b, s):
    """Position value in USDC_raw (fees excluded)."""
    x, y = composition(L, a, b, s)
    return x + weth_to_usdc_raw(y, s)


# ------------------------------------------------------------------ benchmark

def benchmark(rows, capital_usdc=CAPITAL_USDC):
    """Per-unit-L benchmark (per-day table + week closed form), plus the same
    view scaled to a fixed full-range position of `capital_usdc`."""
    days = []
    cur = None
    fg0 = fg1 = 0.0            # week fee accumulators per unit L (raw)
    skipped = 0
    week_first = None
    vol_usdc_raw = weth_usdc_raw = 0.0     # pool volume (input side)

    for r in rows:
        if week_first is None:
            week_first = r["s"]
        if cur is None or cur["day"] != r["day"]:
            if cur:
                days.append(cur)
            cur = {"day": r["day"], "swaps": 0, "s_first": r["s"], "s_last": r["s"],
                   "fg0_start": fg0, "fg1_start": fg1, "skipped": 0,
                   "vol0": 0.0, "vol1": 0.0}
        cur["s_last"] = r["s"]
        cur["swaps"] += 1
        tok = input_token(r["amount0"], r["amount1"])
        cur["vol0"] += max(r["amount0"], 0)
        cur["vol1"] += max(r["amount1"], 0)
        if r["L"] <= 0 or tok is None:
            cur["skipped"] += 1
            skipped += 1
            continue
        if tok == "usdc":
            fg0 += FEE_RATE * r["amount0"] / r["L"]
        else:
            fg1 += FEE_RATE * r["amount1"] / r["L"]
    if cur:
        days.append(cur)

    def per_L_usdc(f0, f1, s_end):
        """fees + 0 (no IL) in human USDC per unit L, WETH fees at s_end."""
        return f0 / 1e6 + f1 / (P(s_end) * 1e6)

    def il_per_L_usdc(s0, s1, s_end):
        """IL term in human USDC per unit L: -L(s1-s0)^2/s0 in WETH_raw, /P_end."""
        return -((s1 - s0) ** 2 / s0) / (P(s_end) * 1e6)

    day_rows = []
    for d in days:
        f = per_L_usdc(fg0 - d["fg0_start"], fg1 - d["fg1_start"], d["s_last"])
        il = il_per_L_usdc(d["s_first"], d["s_last"], d["s_last"])
        day_rows.append({
            "day": d["day"], "swaps": d["swaps"],
            "eth_first": eth_price_human(d["s_first"]),
            "eth_last": eth_price_human(d["s_last"]),
            "vol_usd": usdc_human(d["vol0"] + weth_to_usdc_raw(d["vol1"], d["s_last"])),
            "fees_per_L": f, "il_per_L": il, "day_bm_per_L": f + il,
        })

    s_end = rows[-1]["s"]
    fees_L = per_L_usdc(fg0, fg1, s_end)
    il_L = il_per_L_usdc(week_first, s_end, s_end)
    week = {
        "fees_per_L": fees_L,
        "il_per_L": il_L,
        "benchmark_per_L": fees_L + il_L,
        "sum_daily_bm_per_L": sum(d["day_bm_per_L"] for d in day_rows),
    }

    # same-capital full-range position: value per L in USDC_raw = 2s/P = 2/s
    D_raw = capital_usdc * 1e6
    Lb = D_raw * week_first / 2.0
    vol_week = sum(d["vol0"] + weth_to_usdc_raw(d["vol1"], d["s_last"]) for d in days)
    cap = {
        "L": Lb,
        "fees_usd": usdc_human(fg0 * Lb) + usdc_human(weth_to_usdc_raw(fg1 * Lb, s_end)),
        "il_usd": usdc_human(weth_to_usdc_raw(-((s_end - week_first) ** 2 / week_first) * Lb, s_end)),
        "pool_volume_usd": usdc_human(vol_week),
    }
    cap["bm_usd"] = cap["fees_usd"] + cap["il_usd"]
    return day_rows, week, cap, skipped


# --------------------------------------------------------- toy strategies

def simulate_strategy(rows, wide_pct, chase, capital_usdc=CAPITAL_USDC):
    """Range LP on fixed capital D; chase=True re-centers on range exit.

    Returns (per-day rows, summary, same-capital passive benchmark summary),
    all human USDC on the fixed capital.
    """
    D_raw = capital_usdc * 1e6
    w = math.sqrt(1.0 + wide_pct)

    s0 = rows[0]["s"]
    a, b = s0 / w, s0 * w
    L = D_raw / shape_usdc_per_L(a, b, s0)     # position liquidity units
    Lb = D_raw * s0 / 2.0                      # same capital, full range
    x0, y0 = composition(L, a, b, s0)          # HODL reference (initial inventory)
    assert abs(usdc_value(L, a, b, s0) - D_raw) < D_raw * 1e-9

    fee_usdc = fee_weth = 0.0                  # position fee accumulators (raw)
    bfee_usdc = bfee_weth = 0.0                # benchmark fee accumulators (raw)
    costs = 0.0                                # USDC_raw rebalance costs
    rebalances = 0
    s_end = s0
    days = []
    cur = None

    for r in rows:
        s = r["s"]
        s_end = s
        if cur is None or cur["day"] != r["day"]:
            if cur:
                days.append(cur)
            cur = {"day": r["day"], "swaps": 0, "fu": 0.0, "fw": 0.0,
                   "bu": 0.0, "bw": 0.0, "cost": 0.0, "rebal": 0}
        cur["swaps"] += 1

        tok = input_token(r["amount0"], r["amount1"])
        in_range = a <= s <= b
        if tok is not None and r["L"] > 0 and in_range:
            share = L / r["L"]
            bshare = Lb / r["L"]
            if tok == "usdc":
                f = FEE_RATE * r["amount0"]
                fee_usdc += f * share
                cur["fu"] += f * share
                bfee_usdc += f * bshare
                cur["bu"] += f * bshare
            else:
                f = FEE_RATE * r["amount1"]
                fee_weth += f * share
                cur["fw"] += f * share
                bfee_weth += f * bshare
                cur["bw"] += f * bshare

        if chase and not in_range:
            # re-center at the current price, trading inventory to the fresh shape
            a_new, b_new = s / w, s * w
            x_old, y_old = composition(L, a, b, s)
            V_old = x_old + weth_to_usdc_raw(y_old, s)
            L_new = V_old / shape_usdc_per_L(a_new, b_new, s)   # preserve capital
            x_new, y_new = composition(L_new, a_new, b_new, s)
            notional = abs(x_new - x_old) + abs(weth_to_usdc_raw(y_new - y_old, s))
            c = REBAL_COST_RATE * notional
            costs += c
            cur["cost"] += c
            cur["rebal"] += 1
            rebalances += 1
            L, a, b = L_new, a_new, b_new
    if cur:
        days.append(cur)

    P_end = P(s_end)
    value = usdc_value(L, a, b, s_end) + fee_usdc + weth_to_usdc_raw(fee_weth, s_end) - costs
    hodl = x0 + weth_to_usdc_raw(y0, s_end)
    bvalue = 2.0 * Lb * s_end / P_end + bfee_usdc + weth_to_usdc_raw(bfee_weth, s_end)
    bhodl = (Lb / s0) + weth_to_usdc_raw(Lb * s0, s_end)

    def finish(week_fee_usdc, week_fee_weth, v, h, n_rebal, rebal_cost):
        fees_usd = usdc_human(week_fee_usdc) + usdc_human(weth_to_usdc_raw(week_fee_weth, s_end))
        return {
            "rebalances": n_rebal,
            "fees_usd": fees_usd,
            "rebal_cost_usd": usdc_human(rebal_cost),
            "hodl_usd": usdc_human(h),
            "value_usd": usdc_human(v),
            "excess_vs_hodl_usd": usdc_human(v - h),
            "fees_bps": fees_usd / capital_usdc * 1e4,
            "rebal_cost_bps": usdc_human(rebal_cost) / capital_usdc * 1e4,
            "excess_vs_hodl_bps": usdc_human(v - h) / capital_usdc * 1e4,
        }

    summary = finish(fee_usdc, fee_weth, value, hodl, rebalances, costs)
    bench_summary = finish(bfee_usdc, bfee_weth, bvalue, bhodl, 0, 0.0)
    bench_summary["wide_pct"] = None

    day_rows = []
    for d in days:
        f_usd = usdc_human(d["fu"]) + usdc_human(weth_to_usdc_raw(d["fw"], P_end))
        c_usd = usdc_human(d["cost"])
        day_rows.append({
            "day": d["day"], "swaps": d["swaps"],
            "fees_usd": f_usd, "fees_bps": f_usd / capital_usdc * 1e4,
            "rebal_cost_usd": c_usd, "rebal_cost_bps": c_usd / capital_usdc * 1e4,
            "rebalances": d["rebal"],
        })
    return day_rows, summary, bench_summary


# -------------------------------------------------------------------- checks

def consistency_checks(rows, min_notional_usd=10.0):
    """Decode sanity: trade price implied by (amount0, amount1) ~ spot price.
    Dust swaps (integer rounding at tick granularity) are excluded."""
    devs = []
    for r in rows:
        a0, a1 = r["amount0"], r["amount1"]
        if a0 == 0 or a1 == 0:
            continue
        if abs(a0) / 1e6 < min_notional_usd or abs(a1) / 1e18 * 2000 < min_notional_usd:
            continue
        px = eth_price_human(r["s"])
        if a0 < 0:      # pool paid USDC, received WETH: trade = USDC per WETH
            trade = abs(a0) / 1e6 / (abs(a1) / 1e18)
        else:           # pool paid WETH, received USDC
            trade = (abs(a0) / 1e6) / (abs(a1) / 1e18)
        devs.append(abs(trade - px) / px)
    devs.sort()
    n = len(devs)
    med = devs[n // 2]
    p99 = devs[min(n - 1, int(0.99 * n))]
    return med, p99, n


# ---------------------------------------------------------------------- main

def main():
    rows = load_swaps()
    print(f"loaded {len(rows)} swaps from {os.path.basename(CSV_PATH)}")

    med, p99, n = consistency_checks(rows)
    print(f"decode check over {n} swaps >= $10: trade price vs spot "
          f"median dev {med:.4%}, p99 {p99:.4%} (tick granularity ~0.1%)")

    day_rows, week, cap, skipped = benchmark(rows)
    print("\n=== Passive full-range benchmark, per unit in-range liquidity (USDC) ===")
    print(f"{'day':<12}{'swaps':>7}{'ETH first':>10}{'ETH last':>10}{'vol $M':>9}"
          f"{'fees/L':>12}{'IL/L':>12}{'day bm/L':>12}")
    for d in day_rows:
        print(f"{d['day']:<12}{d['swaps']:>7}{d['eth_first']:>10.2f}{d['eth_last']:>10.2f}"
              f"{d['vol_usd'] / 1e6:>9.2f}{d['fees_per_L']:>12.3e}{d['il_per_L']:>12.3e}"
              f"{d['day_bm_per_L']:>12.3e}")
    print(f"\nweek closed form: fees/L {week['fees_per_L']:.3e} USDC, "
          f"IL term/L {week['il_per_L']:.3e} USDC")
    print(f"week benchmark/L = {week['benchmark_per_L']:.3e} USDC "
          f"= fees - (s1-s0)^2/s0 over week endpoints (all at end price)")
    print(f"sum of daily rows = {week['sum_daily_bm_per_L']:.3e} USDC "
          f"(differs from the weekly figure: IL is not additive across days)")
    print(f"(skipped {skipped} ambiguous/zero-liquidity swaps for fee accrual)")
    print(f"pool week volume ~ ${cap['pool_volume_usd']:,.0f} (input side, WETH at "
          f"end price); pool fees = 5 bps of that by construction")

    print(f"\nsame-capital passive view: ${CAPITAL_USDC:,.0f} full-range -> "
          f"fees ${cap['fees_usd']:,.2f}, IL ${cap['il_usd']:,.2f}, "
          f"benchmark total ${cap['bm_usd']:,.2f}")

    print("\n=== Toy strategies on the same capital vs same-capital benchmark ===")
    results = {}
    for name, w, chase in (("Patient (static ±10%)", 0.10, False),
                           ("Chaser (re-center ±2%)", 0.02, True)):
        d_rows, st, bs = simulate_strategy(rows, w, chase)
        results[name] = {"strategy": st, "benchmark_same_capital": bs, "days": d_rows}
        print(f"\n{name}: {st['rebalances']} rebalances in the week")
        print(f"{'day':<12}{'swaps':>7}{'fees bps':>10}{'rebal bps':>11}{'rebalances':>11}")
        for d in d_rows:
            print(f"{d['day']:<12}{d['swaps']:>7}{d['fees_bps']:>10.3f}"
                  f"{d['rebal_cost_bps']:>11.3f}{d['rebalances']:>11}")
        print(f"week: fees {st['fees_bps']:.3f} bps | rebal cost {st['rebal_cost_bps']:.3f} bps "
              f"| excess vs HODL {st['excess_vs_hodl_bps']:+.3f} bps "
              f"(${st['excess_vs_hodl_usd']:+,.2f})")
        print(f"  same-capital passive benchmark: fees {bs['fees_bps']:.3f} bps, "
              f"excess vs HODL {bs['excess_vs_hodl_bps']:+.3f} bps")
        print(f"  -> strategy vs par (excess difference): "
              f"{st['excess_vs_hodl_bps'] - bs['excess_vs_hodl_bps']:+.3f} bps of capital")

    with open(os.path.join(HERE, "replay_results.json"), "w") as f:
        json.dump({"week_per_L": week, "same_capital_full_range": cap,
                   "strategies": results}, f, indent=2)
    print("\nsaved data/replay_results.json")


if __name__ == "__main__":
    main()
