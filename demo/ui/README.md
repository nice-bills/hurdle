# Hurdle demo UI

Static page, no build, self-contained (works on GitHub Pages from this folder).

```sh
cd demo/ui && python3 -m http.server 8000
# open http://localhost:8000/
```

- `data/<scenario>.json` are copies of `demo/out/<scenario>.json` (real mainnet swap replays; schema: `research/replay-schema.md`). Refresh after a new replay: `cp ../out/range-week.json ../out/down-week.json data/`.
- Scenarios are listed in `scenarios.json`; append `{ "id": "<file stem in data/>", "label": "..." }` for a new one.
- `?s=<id>` picks a scenario, `#play` autoplays (handy for screen recording): `http://localhost:8000/?s=range-week#play`, `?s=down-week#play`.
- Keys: `space` play/pause, `←/→` step one point, `Home` restart, `End` final view, `t` theme. Opens on the static final view.
- **Live panel** reads the Unichain Sepolia vaults (chain 1301) with plain `fetch` + `eth_call` / `eth_getLogs`, no libraries. Edit `live.json` (`rpc`, `patient`, `chaser`, `explorer`, optional `fromBlock` to bound the event scan) after a redeploy. The RPC caps `eth_getLogs` at 1000 blocks and rate-limits bursts, so events are scanned in paced 1000-block chunks: the latest ~5k blocks plus a window around the last settle (from `start().timestamp`); "Scan older events" goes back 12k more. If the RPC is down or a function is missing (older deployment) the field shows `n/a` and the rest of the page keeps working.
- Selectors/topics were computed with `cast sig` / `cast keccak`; see the constants in `index.html`.
- Works from 390 px wide up.
