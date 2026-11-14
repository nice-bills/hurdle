"""Fetch ~7 consecutive recent days of Uniswap v3 Swap events (ETH/USDC 0.05%, mainnet).

Pool: 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640  (v3, fee 0.05%, WETH/USDC)
Window: the 7 most recent COMPLETE UTC days (day boundaries by block timestamp).
RPCs: free public endpoints only, no API keys. Chunked eth_getLogs with
retry/backoff, endpoint rotation, and adaptive range splitting when an endpoint
rejects a range/result count.

Output:
  data/swaps.csv  (block,timestamp,logIndex,amount0,amount1,sqrtPriceX96,liquidity,tick)
                   gzip'd to data/swaps.csv.gz if > 50 MB
  data/block_timestamps.json  (block -> timestamp cache, reused on rerun)
  data/fetch_meta.json        (block range, row count, endpoints used)

Rerun:  python3 data/fetch_swaps.py
"""
import gzip
import json
import os
import shutil
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    import requests
except ImportError:
    requests = None
    import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))

POOL = "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640"
# topic0 of Swap(address,address,int256,int256,uint160,uint128,int24) as emitted
# by this pool (verified empirically: tick field, sqrtPriceX96 and the two
# amounts are mutually consistent across every sampled event; token0=USDC,
# token1=WETH per pool.token0()/token1(), fee=500).
SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"

DAYS = 7
DAY = 86400

# Endpoints that actually serve eth_getLogs for week-old blocks from here
# (probed 2026-11-14; see data/README.md "RPCs tried" for the rejects).
LOG_RPCS = [
    "https://rpc.mevblocker.io",        # no range limit observed, blockTimestamp in logs
    "https://rpc.flashbots.net",        # max 2000 blocks per getLogs
    "https://eth.drpc.org",             # small ranges only on the free plan
]
# General-purpose endpoints (blockNumber, getBlockByNumber).
GEN_RPCS = LOG_RPCS + [
    "https://ethereum-rpc.publicnode.com",   # archive getLogs needs a token; headers OK
    "https://1rpc.io/eth",
    "https://cloudflare-eth.com",
]
RPCS = GEN_RPCS  # rotation set used by rpc_call

START_CHUNK = 2000        # blocks per eth_getLogs call (flashbots max is 2000)
MIN_CHUNK = 200
REQUEST_TIMEOUT = 60
MAX_RETRIES = 6
WORKERS = 4
USER_AGENT = "hurdle-research/1.0 (replay reference data fetch)"

_lock = threading.Lock()
_rpc_idx = 0
_log_idx = 0


SPLIT_KEYWORDS = ("more than", "greater than", "ranges over", "10000", "response size",
                  "result", "block range", "too large")


class RPCRangeLimit(RuntimeError):
    """Endpoint rejected the block range / result count -> caller should split."""


def rpc_call(method, params, base_url=None):
    """One JSON-RPC call with rotation + exponential backoff."""
    global _rpc_idx
    last_err = None
    for attempt in range(MAX_RETRIES):
        with _lock:
            i = _rpc_idx
            _rpc_idx = (_rpc_idx + 1) % len(RPCS)
        url = base_url or RPCS[i]
        payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        try:
            if requests is not None:
                r = requests.post(url, data=payload, timeout=REQUEST_TIMEOUT,
                                  headers={"Content-Type": "application/json",
                                           "User-Agent": USER_AGENT})
                if r.status_code in (429, 500, 502, 503, 504):
                    raise RuntimeError(f"HTTP {r.status_code}")
                r.raise_for_status()
                data = r.json()
            else:
                req = urllib.request.Request(url, data=payload, headers={
                    "Content-Type": "application/json", "User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
                    data = json.loads(resp.read())
            if "error" in data:
                msg = json.dumps(data["error"])[:300].lower()
                if any(k in msg for k in SPLIT_KEYWORDS):
                    raise RPCRangeLimit(msg)
                raise RuntimeError(msg)
            return data["result"]
        except RPCRangeLimit:
            raise
        except Exception as e:  # noqa: BLE001  (rate limits, timeouts, transient)
            last_err = e
            time.sleep(min(2 ** attempt, 20))
    raise RuntimeError(f"RPC failed after {MAX_RETRIES} retries: {last_err}")


def rpc_log_call(params):
    """eth_getLogs through the log-capable endpoints only."""
    global _log_idx
    last_err = None
    for attempt in range(MAX_RETRIES):
        with _lock:
            i = _log_idx
            _log_idx = (_log_idx + 1) % len(LOG_RPCS)
        url = LOG_RPCS[i]
        payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_getLogs", "params": params}).encode()
        try:
            r = requests.post(url, data=payload, timeout=REQUEST_TIMEOUT,
                              headers={"Content-Type": "application/json",
                                       "User-Agent": USER_AGENT})
            if r.status_code in (429, 500, 502, 503, 504):
                raise RuntimeError(f"HTTP {r.status_code}")
            r.raise_for_status()
            data = r.json()
            if "error" in data:
                msg = json.dumps(data["error"])[:300].lower()
                if any(k in msg for k in SPLIT_KEYWORDS):
                    raise RPCRangeLimit(msg)
                raise RuntimeError(msg)
            return data["result"] or []
        except RPCRangeLimit:
            raise
        except Exception as e:  # noqa: BLE001
            last_err = e
            time.sleep(min(2 ** attempt, 15))
    raise RuntimeError(f"getLogs failed after {MAX_RETRIES} retries: {last_err}")


def hexint(h):
    return int(h, 16) if h else 0


def latest_block():
    return hexint(rpc_call("eth_blockNumber", []))


def block_timestamp(block_hex):
    b = rpc_call("eth_getBlockByNumber", [block_hex, False])
    if b is None:
        raise RuntimeError(f"block {block_hex} not found")
    return hexint(b["timestamp"])


def timestamp_at(target_ts):
    """Smallest block whose timestamp >= target_ts (binary search)."""
    hi = latest_block()
    lo = 1
    ts_hi = block_timestamp(hex(hi))
    while ts_hi < target_ts:  # node may lag; wait then re-read head
        time.sleep(10)
        hi = latest_block()
        ts_hi = block_timestamp(hex(hi))
    while lo < hi:
        mid = (lo + hi) // 2
        ts = block_timestamp(hex(mid))
        if ts < target_ts:
            lo = mid + 1
        else:
            hi = mid
    return lo


def fetch_range(lo, hi, endpoints_state):
    """All matching logs in block range [lo, hi]; splits the range if rejected."""
    if lo > hi:
        return []
    chunk = hi - lo + 1
    if chunk > MIN_CHUNK:
        try:
            return _getlogs(lo, hi)
        except RPCRangeLimit:
            endpoints_state["split"] += 1
            mid = (lo + hi) // 2
            left = fetch_range(lo, mid, endpoints_state)
            right = fetch_range(mid + 1, hi, endpoints_state)
            return left + right
    return _getlogs(lo, hi)


def _getlogs(lo, hi):
    params = [{
        "address": POOL,
        "topics": [SWAP_TOPIC],
        "fromBlock": hex(lo),
        "toBlock": hex(hi),
    }]
    return rpc_log_call(params)


def decode_words(log):
    """Decode Swap event data: 5 words (amount0, amount1, sqrtPriceX96,
    liquidity, tick); amount0/amount1 are signed int256, tick int24
    (sign-extended in its 32-byte word)."""
    d = log["data"][2:]
    words = [d[i * 64:(i + 1) * 64] for i in range(5)]

    def w_int(w):
        v = int(w, 16)
        return v - (1 << 256) if v >= (1 << 255) else v

    amount0 = w_int(words[0])
    amount1 = w_int(words[1])
    sqrt_price = int(words[2], 16)
    liquidity = int(words[3], 16)
    tick = w_int(words[4])
    return amount0, amount1, sqrt_price, liquidity, tick


def fetch_all_chunks(from_block, to_block, endpoints_state):
    """getLogs in chunks, parallel across workers, adaptive splitting."""
    chunks = []
    b = from_block
    while b <= to_block:
        chunks.append((b, min(b + START_CHUNK - 1, to_block)))
        b += START_CHUNK
    print(f"{len(chunks)} getLogs chunks of <= {START_CHUNK} blocks, {WORKERS} workers")

    t0 = time.time()
    logs = []
    done = 0
    errors = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(fetch_range, lo, hi, endpoints_state): (lo, hi) for lo, hi in chunks}
        for fut in as_completed(futs):
            lo, hi = futs[fut]
            try:
                res = fut.result()
            except Exception as e:  # noqa: BLE001
                errors += 1
                print(f"  chunk {lo}-{hi} FAILED: {e}", flush=True)
                continue
            logs.extend(res)
            done += 1
            if done % 5 == 0 or done == len(chunks):
                print(f"  chunks {done}/{len(chunks)}: {len(logs)} logs "
                      f"({time.time() - t0:.0f}s)", flush=True)
    if errors:
        raise RuntimeError(f"{errors}/{len(chunks)} chunks failed; rerun the script "
                           "(range is deterministic; duplicates are removed on merge)")
    print(f"raw logs: {len(logs)}, range splits: {endpoints_state['split']}, "
          f"{time.time() - t0:.0f}s")
    return logs


def main():
    t0 = time.time()
    ts_cache_path = os.path.join(HERE, "block_timestamps.json")
    ts_cache = {}
    if os.path.exists(ts_cache_path):
        with open(ts_cache_path) as f:
            ts_cache = {int(k): v for k, v in json.load(f).items()}
    print(f"timestamp cache: {len(ts_cache)} blocks")

    head = latest_block()
    head_ts = ts_cache.get(head) or block_timestamp(hex(head))
    ts_cache[head] = head_ts
    print(f"head block {head} ts {head_ts} ({time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(head_ts))} UTC)")

    # Window = 7 complete UTC days, ending at the last completed UTC midnight.
    end_midnight = head_ts - (head_ts % DAY)          # today 00:00 UTC (partial day)
    start_midnight = end_midnight - DAYS * DAY        # 7 full days before that
    from_block = timestamp_at(start_midnight)
    to_block = timestamp_at(end_midnight) - 1
    print(f"fetching blocks {from_block}..{to_block} "
          f"({to_block - from_block + 1} blocks, {DAYS} full UTC days "
          f"{time.strftime('%Y-%m-%d', time.gmtime(start_midnight))} .. "
          f"{time.strftime('%Y-%m-%d', time.gmtime(end_midnight - 1))})")

    # Resume support: cache the raw logs of a completed full fetch so a rerun
    # (e.g. after a crash in postprocessing) does not hit the RPCs again.
    cache_path = os.path.join(HERE, ".rawlogs_cache.json.gz")
    endpoints_state = {"split": 0}
    logs = None
    if os.path.exists(cache_path):
        try:
            with gzip.open(cache_path, "rt") as f:
                c = json.load(f)
            if c["from_block"] == from_block and c["to_block"] == to_block:
                logs = c["logs"]
                print(f"raw-log cache hit: {len(logs)} logs for the same window")
        except Exception as e:  # noqa: BLE001
            print(f"raw-log cache unreadable ({e}); refetching")

    if logs is None:
        logs = fetch_all_chunks(from_block, to_block, endpoints_state)
        # timestamps embedded by the RPC get cached below; persist cache only
        # for logs without timestamps? No: store raw as-is, cheap enough.
        with gzip.open(cache_path, "wt") as f:
            json.dump({"from_block": from_block, "to_block": to_block,
                       "logs": logs}, f)
        print("raw-log cache written")

    # Dedup (parallel split overlap safety) and sort by (block, logIndex)
    seen = set()
    rows = []
    for lg in logs:
        key = (lg["blockNumber"], lg["transactionHash"], lg["logIndex"])
        if key in seen:
            continue
        seen.add(key)
        amount0, amount1, sqrt_price, liquidity, tick = decode_words(lg)
        blk = hexint(lg["blockNumber"])
        # several endpoints (mevblocker, drpc) embed blockTimestamp in each log
        if lg.get("blockTimestamp"):
            ts = hexint(lg["blockTimestamp"])
            ts_cache[blk] = ts
        else:
            ts = ts_cache.get(blk)
        rows.append({
            "block": blk,
            "logIndex": hexint(lg["logIndex"]),
            "amount0": amount0,
            "amount1": amount1,
            "sqrtPriceX96": sqrt_price,
            "liquidity": liquidity,
            "tick": tick,
            "_ts": ts,
        })
    rows.sort(key=lambda r: (r["block"], r["logIndex"]))

    # Missing timestamps: fetch in parallel, batched through the cache
    missing = sorted({r["block"] for r in rows if r["_ts"] is None})
    print(f"blocks needing timestamps: {len(missing)} (cache hit {len(rows) - len(missing)})")

    def ts_of(b):
        if b in ts_cache:
            return b, ts_cache[b]
        val = block_timestamp(hex(b))
        return b, val

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for b, val in ex.map(ts_of, missing):
            ts_cache[b] = val
    for r in rows:
        r["_ts"] = ts_cache[r["block"]]

    with open(ts_cache_path, "w") as f:
        json.dump({str(k): v for k, v in sorted(ts_cache.items())}, f)
    print(f"timestamp cache saved: {len(ts_cache)} blocks")

    csv_path = os.path.join(HERE, "swaps.csv")
    header = "block,timestamp,logIndex,amount0,amount1,sqrtPriceX96,liquidity,tick"
    lines = [header]
    for r in rows:
        lines.append(f"{r['block']},{r['_ts']},{r['logIndex']},{r['amount0']},{r['amount1']},"
                     f"{r['sqrtPriceX96']},{r['liquidity']},{r['tick']}")
    size = sum(len(l) + 1 for l in lines)
    if size > 50 * 1024 * 1024:
        gz = csv_path + ".gz"
        with open(gz, "wb") as f:
            with gzip.GzipFile(fileobj=f, mode="wb") as g:
                g.write("\n".join(lines).encode())
        print(f"wrote {gz} ({os.path.getsize(gz) / 1e6:.1f} MB gzipped; {size / 1e6:.1f} MB raw)")
        out = gz
    else:
        with open(csv_path, "w") as f:
            f.write("\n".join(lines) + "\n")
        print(f"wrote {csv_path} ({os.path.getsize(csv_path) / 1e6:.1f} MB)")
        out = csv_path

    days = {}
    for r in rows:
        day = time.strftime("%Y-%m-%d", time.gmtime(r["_ts"]))
        days[day] = days.get(day, 0) + 1

    # boundary block timestamps for the meta record (fetch if absent)
    for b in (from_block, to_block):
        if b not in ts_cache:
            ts_cache[b] = block_timestamp(hex(b))

    meta = {
        "pool": POOL,
        "pool_label": "Uniswap v3 WETH/USDC 0.05% (Ethereum mainnet)",
        "swap_topic": SWAP_TOPIC,
        "token0": "USDC (0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48, 6 dec)",
        "token1": "WETH (0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2, 18 dec)",
        "log_rpcs": LOG_RPCS,
        "general_rpcs": GEN_RPCS,
        "from_block": from_block,
        "to_block": to_block,
        "window_start_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts_cache[from_block])),
        "window_end_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts_cache[to_block])),
        "swaps": len(rows),
        "days_utc": days,
        "output": out,
        "fetch_seconds": round(time.time() - t0, 1),
    }
    with open(os.path.join(HERE, "fetch_meta.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print(json.dumps(meta["days_utc"], indent=2))
    try:
        os.remove(cache_path)
        print("raw-log cache removed (fetch complete)")
    except FileNotFoundError:
        pass
    print(f"done in {time.time() - t0:.0f}s: {len(rows)} swaps -> {out}")


if __name__ == "__main__":
    main()
