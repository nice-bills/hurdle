#!/usr/bin/env bash
# End-to-end validation: build, all tests, both real-week replays, par check, UI data + smoke, optional live read.
# Usage: ./e2e.sh            (offline)      E2E_LIVE=1 ./e2e.sh   (also read-only calls to Unichain Sepolia)
#        E2E_APP=1 ./e2e.sh  (step h: headless-chromium smoke of the live dApp, see e2e_app_smoke.mjs)
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.foundry/bin:$PATH"
export FOUNDRY_OUT=out-e2e FOUNDRY_CACHE_PATH=cache-e2e
RPC="${E2E_RPC:-https://sepolia.unichain.org}"
SCRATCH="$(mktemp -d)"
SERVER_PID=""
trap '[ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$SCRATCH"' EXIT

NAMES=(); STATUS=(); SECS=(); CUR=""; T0=0
# E2E_SKIP="b" skips steps by letter (e.g. to rerun later steps while a suite is being fixed)
step() { CUR="$1"; T0=$SECONDS
  if [[ " ${E2E_SKIP:-} " == *" ${1%%.*} "* ]]; then printf '\n=== %s (skipped via E2E_SKIP) ===\n' "$1"; NAMES+=("$1"); STATUS+=("SKIP"); SECS+=(0); return 1; fi
  printf '\n=== %s ===\n' "$1"; }
pass() { NAMES+=("$CUR"); STATUS+=("PASS"); SECS+=($((SECONDS - T0))); }
skip() { NAMES+=("$CUR"); STATUS+=("SKIP"); SECS+=(0); echo "skipped: $1"; }
summary() {
  printf '\n%-50s %-6s %7s\n' STEP STATUS SECONDS
  local i; for i in "${!NAMES[@]}"; do printf '%-50s %-6s %7s\n' "${NAMES[$i]}" "${STATUS[$i]}" "${SECS[$i]}"; done
  printf '%-50s %-6s %7s\n' TOTAL "" "$SECONDS"
}
die() {
  echo "E2E FAILED at step '$CUR': $*" >&2
  NAMES+=("$CUR"); STATUS+=("FAIL"); SECS+=($((SECONDS - T0))); summary; exit 1
}

WEEKS=("2026-10-31:range-week:Range-bound week (Oct 31 – Nov 6)" "2026-11-07:down-week:ETH −14% week (Nov 7 – 13)")

if step "a. build + contract size"; then
forge build --sizes 2>&1 | tee "$SCRATCH/build.txt" | grep -E "^\| HurdleVault  |Compiler run|^Error" || true
size=$(grep -E '^\| *HurdleVault *\|' "$SCRATCH/build.txt" | head -1 | awk -F'|' '{gsub(/[ ,]/,"",$3); print $3}')
[ -n "$size" ] || die "could not find HurdleVault in forge build --sizes output"
echo "HurdleVault runtime size: $size bytes (limit 24576)"
[ "$size" -lt 24576 ] || die "HurdleVault runtime $size >= 24576"
pass
fi

if step "b. forge test (all suites)"; then
forge test 2>&1 | tee "$SCRATCH/test.txt" | tail -25 || true
grep -qE 'Suite result|Ran [0-9]+ test suites' "$SCRATCH/test.txt" || die "forge test produced no results (compile error?)"
if grep -E '^Ran [0-9]+ test suites' "$SCRATCH/test.txt" | grep -qE ', 0 failed' && ! grep -qE '\[FAIL' "$SCRATCH/test.txt"; then :; else
  grep -E '\[FAIL|Failing tests' -A3 "$SCRATCH/test.txt" | head -40 >&2; die "forge test has failures"; fi
grep -E '^Ran [0-9]+ test suites' "$SCRATCH/test.txt"
pass
fi

mkdir -p demo/out demo/ui/data
if step "c. replay both real weeks"; then
for w in "${WEEKS[@]}"; do IFS=: read -r date scen label <<<"$w"
  echo "-- $date -> demo/out/$scen.csv"
  REPLAY_CSV="data/weeks/$date.csv" REPLAY_OUT="demo/out/$scen.csv" \
    forge test --match-contract ReplayTest -vv 2>&1 | tee "$SCRATCH/replay-$scen.txt" | tail -8 || true
  grep -qE '\[PASS\]' "$SCRATCH/replay-$scen.txt" && ! grep -qE '\[FAIL' "$SCRATCH/replay-$scen.txt" || die "replay $date did not PASS"
  [ -s "demo/out/$scen.csv" ] || die "replay $date wrote no demo/out/$scen.csv"
done
pass
fi

if step "d. par check vs offchain reference (<= 0.01 bp)"; then
for w in "${WEEKS[@]}"; do IFS=: read -r date scen label <<<"$w"
  out=$(python3 -I data/par_check.py "data/weeks/$date.csv" "demo/out/$scen.csv" --twap) || die "par_check failed for $date: $out"
  echo "$out"
  mx=$(sed -nE 's/^max \|diff\| over all settlements ([0-9.]+) bp.*/\1/p' <<<"$out")
  [ -n "$mx" ] || die "could not parse max |diff| for $date"
  python3 -I -c "import sys; sys.exit(0 if float('$mx') <= 0.01 else 1)" || die "$date max |diff| $mx bp > 0.01 bp"
done
pass
fi

if step "e. build UI JSON"; then
for w in "${WEEKS[@]}"; do IFS=: read -r date scen label <<<"$w"
  python3 -I demo/build_json.py "demo/out/$scen.csv" "$label" | cut -c1-160
  cp "demo/out/$scen.json" "demo/ui/data/$scen.json"
done
pass
fi

if step "f. UI smoke (headless chromium, 1280 + 390 px)"; then
CHROME=""; for c in chromium chromium-browser google-chrome-stable google-chrome; do command -v "$c" >/dev/null 2>&1 && { CHROME=$(command -v "$c"); break; }; done
if [ -z "$CHROME" ] || ! command -v node >/dev/null 2>&1; then skip "needs node and chromium/chrome on PATH"; else
  PORT=$(python3 -I -c "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1])")
  python3 -I -m http.server "$PORT" --bind 127.0.0.1 --directory demo/ui >"$SCRATCH/http.log" 2>&1 &
  SERVER_PID=$!
  UP=""; for _ in $(seq 50); do curl -fs "http://127.0.0.1:$PORT/scenarios.json" >/dev/null 2>&1 && { UP=1; break; }; sleep 0.1; done
  [ -n "$UP" ] || die "UI smoke: local http.server did not come up (see $SCRATCH/http.log)"
  node e2e_ui_smoke.mjs "$CHROME" "http://127.0.0.1:$PORT" || die "UI smoke failed"
  kill "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""
  pass
fi
fi

if step "g. live read-only check (E2E_LIVE=1)"; then
if [ "${E2E_LIVE:-0}" != "1" ]; then skip "set E2E_LIVE=1 to enable"; else
  read -r PV CV RV < <(python3 -I - <<'PY'
import json
d = json.load(open("script/out/deploy-1301.json"))
p, c, r = d.get("patientVault"), d.get("chaserVault"), d.get("recklessVault")
if not (p and c and r):  # deploy json has no vault keys: take them from the DeployVaults broadcast (patient first, chaser second)
    t = json.load(open("broadcast/DeployVaults.s.sol/1301/run-latest.json"))["transactions"]
    v = [x["contractAddress"] for x in t if x.get("transactionType") == "CREATE" and x.get("contractName") == "HurdleVault"]
    p, c, r = v[0], v[1], v[2]
print(p, c, r)
PY
)
  for pair in "patientVault:$PV" "chaserVault:$CV" "recklessVault:$RV"; do n=${pair%%:*}; a=${pair#*:}
    nav=$(cast call "$a" "nav()(uint256)" --rpc-url "$RPC") || die "$n nav() call failed"
    fired=$(cast call "$a" "fired()(bool)" --rpc-url "$RPC") || die "$n fired() call failed"
    bond=$(cast call "$a" "bond()(uint256)" --rpc-url "$RPC") || die "$n bond() call failed"
    echo "$n $a  nav=$nav  fired=$fired  bond=$bond"
  done
  pass
fi
fi

if step "h. dApp smoke (E2E_APP=1; live app, 1280 + 390 px)"; then
if [ "${E2E_APP:-0}" != "1" ]; then skip "set E2E_APP=1 to enable (E2E_APP_URL overrides https://hurdle-app.onrender.com)"; else
  CHROME=""; for c in /usr/bin/chromium chromium chromium-browser google-chrome-stable google-chrome; do command -v "$c" >/dev/null 2>&1 && { CHROME=$(command -v "$c"); break; }; done
  if [ -z "$CHROME" ] || ! command -v node >/dev/null 2>&1; then die "E2E_APP=1 needs node and chromium/chrome"; fi
  node e2e_app_smoke.mjs "$CHROME" "${E2E_APP_URL:-https://hurdle-app.onrender.com}" app/shared/deployment-1301.json || die "dApp smoke failed"
  pass
fi
fi

summary
echo "E2E OK"
