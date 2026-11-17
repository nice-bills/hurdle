# Council review brief

You are one of four independent reviewers rating **Hurdle**, a submission to the Uniswap Hook
Incubator (UHI11) Hookathon. Theme: **Active Management and Curated Liquidity**. Judges look at
originality, technical depth and correctness of the v4 hook, security, real-world usefulness, quality of
the tests, the live deployment, documentation, the UI and the demo. Rate the **whole submission** as it
stands at the version named in your task.

Repo: /home/bills/code/hurdle (Foundry). Start with README.md and IDEA.md, then src/, test/, script/,
data/, demo/ (UI: demo/ui/index.html, served with `cd demo && python3 -m http.server 8000`), research/.
Live on Unichain Sepolia (chain 1301): addresses in README.md, RPC https://sepolia.unichain.org (read-only
calls via `cast call` are fine).

Rules
- Read-only. Do not edit, create, delete, commit or deploy anything in the repo, except your own review
  file named in your task. Never send a transaction.
- If you build or test, use your own dirs: `FOUNDRY_OUT=out-<you> FOUNDRY_CACHE_PATH=cache-<you> forge test`.
  Do not run the replay with REPLAY_OUT pointing into demo/out.
- Judge the work, not the effort. Be specific and honest; a 10 means you would not change anything that
  matters for winning this hackathon.
- Things already fixed or documented on purpose are listed in research/audit2.md, research/audit-fixes.md
  and the README "Limits" section. You may disagree with a documented trade-off, but say why it matters.

Output: write your review to the file named in your task, in exactly this shape, and also return it as
your final message:

```
# <reviewer> — <version>
Score: N/10
## Why not 10 (blocking items, most important first)
1. <file:line or area> — <problem> — <what would make it a 10>
...
## Strengths (max 5 lines)
## Nits (optional, do not affect score)
```

Every blocking item must be concrete and actionable. If you have none, the score is 10.
