"""Convert the on-chain replay CSV (test/Replay.t.sol) into the UI schema (research/replay-schema.md).

Values are re-expressed in USD (token0) so a falling-ETH week reads as a loss, then normalized to 1.0
at the start. Usage: python3 demo/build_json.py demo/out/range-week.csv "Range-bound week (Oct 31)"
"""
import csv, json, sys, datetime, os

src, label = sys.argv[1], sys.argv[2]
rows = list(csv.DictReader(open(src)))
E18 = 1e18

def usd_per_eth(sqrt_x96):
    p = (int(sqrt_x96) / 2**96) ** 2  # WETH-wei per USDC-unit
    return 1e12 / p

px0 = usd_per_eth(rows[0]["sqrtPriceX96"])
points, events, was_fired = [], [], {"patient": False, "chaser": False}
for r in rows:
    px = usd_per_eth(r["sqrtPriceX96"])
    k = px / px0  # WETH-denominated ratio -> USD-denominated ratio
    pt = {"t": int(r["t"]), "price": round(px, 2), "par": int(r["par"]) / E18 * k, "vaults": {}}
    for name, p in (("patient", "p"), ("chaser", "c")):
        fired = r[p + "_fired"] == "1"
        pt["vaults"][name] = {
            "nav": int(r[p + "_nav"]) / E18 * k,
            "depositor": int(r[p + "_dep"]) / E18 * k,
            "bond": int(r[p + "_bond"]) / E18 * k,
            "carry": int(r[p + "_carry"]) / E18 * k,
            "shortfall": int(r[p + "_paid"]) / E18 * k,
            "fired": fired,
        }
        if fired and not was_fired[name]:
            events.append({"t": int(r["t"]), "vault": name, "type": "fired", "note": "bond below 2% of NAV"})
        was_fired[name] = fired
    points.append(pt)

iso = lambda t: datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
scenario = os.path.splitext(os.path.basename(src))[0]
out = {
    "meta": {
        "scenario": scenario,
        "label": label,
        "pool": "ETH/USDC 0.05% — real Uniswap v3 mainnet swaps replayed through a local v4 pool with Hurdle",
        "start": iso(points[0]["t"]), "end": iso(points[-1]["t"]),
        "epochSeconds": 3600, "carryBps": 2000, "minBondBps": 200,
        "unit": "USD, normalized to 1.0 at start",
    },
    "points": points,
    "events": events,
}
dst = os.path.join(os.path.dirname(src), scenario + ".json")
json.dump(out, open(dst, "w"))

# Self-check: the guarantee the demo claims.
for name in ("patient", "chaser"):
    worst = min(p["vaults"][name]["depositor"] - p["par"] for p in points if p["vaults"][name]["bond"] > 0)
    assert worst >= -1e-9, (name, worst)
print(dst, len(points), "points", events)
