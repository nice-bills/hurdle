# Hurdle demo UI

Static page, no build. Reads `../out/<scenario>.json` (schema: `research/replay-schema.md`).

```sh
cd demo && python3 -m http.server 8000
# open http://localhost:8000/ui/
```

- Scenarios are listed in `scenarios.json`; append `{ "id": "<file stem in demo/out>", "label": "..." }` when a real replay lands.
- `?s=<id>` picks a scenario, `#play` autoplays (handy for screen recording): `http://localhost:8000/ui/?s=mock-range-week#play`.
- Keys: `space` play/pause, `←/→` step one point, `Home` restart, `End` final view, `t` theme. Opens on the static final view.
- `mock-*.json` are synthetic (regenerate: `node ui/mock-gen.mjs`); they exist only so the UI works before real data.
- Best at 1280×720.
