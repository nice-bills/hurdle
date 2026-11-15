"""Replay every data/weeks/*.csv(.gz) -> data/weeks/summary.md (+ per-week json).

Columns: ETH start/end/%move (first/last swap price), realized vol (annualized
stdev of hourly log returns of last-swap-per-hour price), volume (swap input
side, USD), passive par excess (same-capital full-range, excess vs HODL, bps of
capital), Patient / Chaser excess minus par (bps of capital).
"""
import glob
import json
import math
import os

import replay_ref as R

HERE = os.path.dirname(os.path.abspath(__file__))
WK = os.path.join(HERE, "weeks")


def realized_vol(path):
    import csv, gzip
    op = gzip.open if path.endswith(".gz") else open
    last = {}
    with op(path, "rt") as f:
        for r in csv.DictReader(f):
            last[int(r["timestamp"]) // 3600] = int(r["sqrtPriceX96"]) / R.Q96
    hrs = sorted(last)
    px = [R.eth_price_human(last[h]) for h in hrs]
    rets = [math.log(b / a) for a, b in zip(px, px[1:])]
    m = sum(rets) / len(rets)
    sd = math.sqrt(sum((x - m) ** 2 for x in rets) / (len(rets) - 1))
    return sd * math.sqrt(8760)


def main():
    out = []
    for path in sorted(glob.glob(os.path.join(WK, "*.csv")) + glob.glob(os.path.join(WK, "*.csv.gz"))):
        name = os.path.basename(path).split(".")[0]
        rows = R.load_swaps(path)
        _, _, cap, _ = R.benchmark(rows)
        res = {}
        for k, w, chase in (("patient", 0.10, False), ("chaser", 0.02, True)):
            _, st, bs = R.simulate_strategy(rows, w, chase)
            res[k] = (st, bs)
        st_p, bs = res["patient"]
        # par = strategy-independent closed-form full-range benchmark; simulate_strategy's own
        # benchmark only accrues fees while the *strategy's* range is in range (a full-range LP always is).
        par = cap["bm_usd"] / R.CAPITAL_USDC * 1e4
        p0, p1 = R.eth_price_human(rows[0]["s"]), R.eth_price_human(rows[-1]["s"])
        out.append({
            "week": name, "swaps": len(rows), "eth0": p0, "eth1": p1, "move_pct": (p1 / p0 - 1) * 100,
            "vol": realized_vol(path), "volume_usd": cap["pool_volume_usd"],
            "par_bps": par,
            "patient_vs_par": st_p["excess_vs_hodl_bps"] - par,
            "chaser_vs_par": res["chaser"][0]["excess_vs_hodl_bps"] - par,
            "patient_bps": st_p["excess_vs_hodl_bps"], "chaser_bps": res["chaser"][0]["excess_vs_hodl_bps"],
            "chaser_rebal": res["chaser"][0]["rebalances"],
            "ch_fee": res["chaser"][0]["fees_bps"], "ch_cost": res["chaser"][0]["rebal_cost_bps"],
            "pa_fee": st_p["fees_bps"],
        })
        with open(os.path.join(WK, name + ".json"), "w") as f:
            json.dump({"strategies": {k: {"strategy": v[0], "benchmark_same_capital": v[1]} for k, v in res.items()},
                       "same_capital_full_range": cap}, f, indent=2)
    out.sort(key=lambda r: r["week"])
    lines = ["# Weekly replay summary", "",
             "Capital $1M; Patient = static ±10%, Chaser = re-center ±2% (data/replay_ref.py, untuned). "
             "'par' = same-capital passive full-range LP (closed form, fees always accrue); bps columns are excess vs HODL in bps of capital, "
             "'vs par' = strategy minus par. Vol = annualized stdev of hourly log returns. Volume = swap input side.", "",
             "| week (UTC start) | swaps | ETH start | ETH end | move % | rvol (ann.) | volume $M | par excess bps | Patient vs par bps | Chaser vs par bps | Chaser rebals | Patient fees bps | Chaser fees / rebal-cost bps |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in out:
        lines.append(f"| {r['week']} | {r['swaps']} | {r['eth0']:.0f} | {r['eth1']:.0f} | {r['move_pct']:+.2f} | "
                     f"{r['vol'] * 100:.0f}% | {r['volume_usd'] / 1e6:,.0f} | {r['par_bps']:+.1f} | "
                     f"{r['patient_vs_par']:+.1f} | {r['chaser_vs_par']:+.1f} | {r['chaser_rebal']} | "
                     f"{r['pa_fee']:.0f} | {r['ch_fee']:.0f} / {r['ch_cost']:.0f} |")
    demo = min(out, key=lambda r: abs(r["move_pct"]))
    lines += ["", "## Selection (rule in data/README.md, fixed before comparing)", "",
              f"- **Demo week** (smallest |net ETH move|): **{demo['week']}**, {demo['move_pct']:+.2f}%.",
              f"  - Patient beats par: **{'YES' if demo['patient_vs_par'] > 0 else 'NO'}** ({demo['patient_vs_par']:+.1f} bps).",
              f"  - Chaser trails par: **{'YES' if demo['chaser_vs_par'] < 0 else 'NO'}** ({demo['chaser_vs_par']:+.1f} bps).",
              "- **Second scenario** (existing down week): 2026-11-07."]
    open(os.path.join(WK, "summary.md"), "w").write("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
