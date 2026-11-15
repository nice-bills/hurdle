# Replay output schema (frozen)

`demo/out/<scenario>.json`, written by the Foundry replay script. All values are numbers (floats OK), normalized so every line starts at 1.0.

```json
{
  "meta": {
    "scenario": "range-bound-week",
    "pool": "ETH/USDC 0.05% (Uniswap v3 mainnet replay)",
    "start": "2026-11-07T00:00:00Z", "end": "2026-11-13T23:59:59Z",
    "epochSeconds": 86400, "carryBps": 2000, "minBondBps": 200,
    "unit": "WETH (token1)"
  },
  "points": [
    {
      "t": 1762473600,          // unix seconds
      "price": 3150.2,          // USDC per ETH, for the price strip
      "par": 1.0,               // passive full-range benchmark, per unit of start capital
      "vaults": {
        "patient": { "nav": 1.0, "depositor": 1.0, "bond": 0.05, "carry": 0.0, "shortfall": 0.0, "fired": false },
        "chaser":  { "nav": 1.0, "depositor": 1.0, "bond": 0.05, "carry": 0.0, "shortfall": 0.0, "fired": false }
      }
    }
  ],
  "events": [
    { "t": 1762700000, "vault": "chaser", "type": "fired", "note": "bond below 2% of NAV" }
  ]
}
```

- `nav`: vault NAV per share before bond top-up (what the curator produced).
- `depositor`: NAV per depositor share after shortfall payment and carry dilution (what the depositor owns). Invariant while bond lasts: `depositor >= par`.
- `bond`, `carry`, `shortfall`: cumulative, as a fraction of start capital.
- `type` in `settle | rebalance | fired`.
