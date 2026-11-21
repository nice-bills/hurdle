import Link from "next/link";
import { HeroChart } from "@/components/hero-chart";
import { IconAlert, IconArrow, IconSnow } from "@/components/icons";
import { LiveScoreboard, LiveVaults } from "@/components/live-stats";

export default function Home() {
  return (
    <div className="pb-8">
      {/* hero */}
      <section className="grid items-center gap-10 pb-12 pt-10 sm:pt-14 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:gap-14 lg:pb-16 lg:pt-20">
        <div>
          <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-line px-3 py-1 text-[12.5px] text-ink-2">
            <span className="bar-hatch h-2 w-5 rounded-full" />
            Uniswap v4 hook · curated liquidity
          </p>
          <h1 className="text-[clamp(2.4rem,5.6vw,4.25rem)] font-bold leading-[1.02] tracking-[-0.035em]">
            Beat par,<br />or pay the difference.
          </h1>
          <p className="mt-6 max-w-[56ch] text-[17px] leading-relaxed text-ink-2">
            A Hurdle curator guarantees its depositors at least <b className="font-semibold text-ink">par</b>: the return of a
            passive full-range LP, computed by the pool from its own fee growth and TWAP. A miss is paid from the curator&apos;s
            bond. Carry is earned only above par.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/vaults" className="inline-flex h-12 items-center gap-2 rounded-lg bg-bar px-5 text-[16px] font-semibold text-on-bar transition-[filter] hover:brightness-105">
              Try it on testnet <IconArrow size={17} />
            </Link>
            <Link href="/replay" className="inline-flex h-12 items-center gap-2 rounded-lg border border-line px-5 text-[16px] font-medium hover:border-line-2 hover:bg-bg-2">
              Watch a real week
            </Link>
          </div>
        </div>
        <div className="rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-6">
          <HeroChart />
        </div>
      </section>

      <LiveScoreboard />

      {/* mechanism */}
      <section className="mt-20" aria-labelledby="how">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-14">
          <div>
            <h2 id="how" className="text-[clamp(1.6rem,3vw,2.2rem)] font-bold leading-tight tracking-[-0.025em]">
              The pool keeps score. Nobody reports their own returns.
            </h2>
            <p className="mt-4 max-w-[52ch] text-[15.5px] leading-relaxed text-ink-2">
              For a full-range position, par has a closed form in two pool snapshots:{" "}
              <code className="whitespace-nowrap rounded bg-bg-2 px-1.5 py-0.5 font-mono text-[13px] text-ink">L·(2·s₁ + Δfg₀·P₁ + Δfg₁)</code>.
              The hook writes a TWAP before every swap and freezes fee growth at the block&apos;s first swap, so neither
              price manipulation nor wash trading inside a block moves it.
            </p>
            <ul className="mt-6 space-y-3 text-[14.5px]">
              {[
                ["No oracle", "par comes from the pool's own feeGrowthGlobal and tick accumulator."],
                ["Anyone settles", "settle() is permissionless; a keeper earns 5% of the epoch's carry."],
                ["Earned capacity", "a vault can hold at most bond ÷ floor, so size follows the bond."],
              ].map(([a, b]) => (
                <li key={a} className="flex gap-3">
                  <span className="bar-hatch mt-2 h-1.5 w-4 shrink-0 rounded-full" />
                  <span><b className="font-semibold">{a}:</b> <span className="text-ink-2">{b}</span></span>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-2xl border border-line bg-bg-2 p-4 sm:p-6">
            <div className="mb-4 flex items-center justify-between text-[13px] text-ink-2">
              <span className="font-semibold text-ink">Every epoch, settle()</span>
              <span>compares the vault&apos;s NAV with par</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Outcome
                tone="good"
                head="NAV ≥ par"
                steps={["The excess first refills any bond paid out earlier.", "The curator keeps 20% of the rest as carry, minted as shares.", "Beating par never fires anyone."]}
              />
              <Outcome
                tone="bad"
                head="NAV < par"
                steps={["The bond pays depositors up to par.", "The payout is recorded as deficit; deposits wait until it is refilled.", "If the bond ends below 1% of NAV, the curator is fired."]}
              />
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Level tone="ice" head="Floor · bond < 2% of NAV" body="Deposits and curator rebalances freeze until the curator tops up." />
              <Level tone="bad" head="Fire line · bond < 1% after a miss" body="The vault swaps to 50/50 and parks full range, where it simply is par." />
            </div>
          </div>
        </div>
      </section>

      <section className="mt-20">
        <LiveVaults />
      </section>

      <section className="mt-20 grid gap-6 rounded-2xl border border-line bg-surface p-6 sm:p-10 lg:grid-cols-[1fr_auto] lg:items-center">
        <div>
          <h2 className="text-[clamp(1.5rem,2.6vw,2rem)] font-bold tracking-[-0.02em]">Run the whole loop on testnet.</h2>
          <p className="mt-2 max-w-[60ch] text-ink-2">
            Mint mock USDC and WETH, deposit in an open window, move the price with a swap, then settle and watch the bond pay
            or the carry accrue. Or start your own vault and post a bond.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link href="/vaults" className="inline-flex h-11 items-center gap-2 rounded-lg bg-bar px-5 font-semibold text-on-bar hover:brightness-105">
            Open a vault <IconArrow size={16} />
          </Link>
          <Link href="/create" className="inline-flex h-11 items-center rounded-lg border border-line px-5 font-medium hover:bg-bg-2">
            Become a curator
          </Link>
          <Link href="/integrate" className="inline-flex h-11 items-center rounded-lg px-3 font-medium text-ink-2 hover:text-ink">
            Developer docs
          </Link>
        </div>
      </section>
    </div>
  );
}

function Outcome({ tone, head, steps }: { tone: "good" | "bad"; head: string; steps: string[] }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className={`mb-3 inline-flex items-center gap-2 rounded-md px-2 py-1 text-[13px] font-semibold ${tone === "good" ? "bg-good-soft text-good" : "bg-bad-soft text-bad"}`}>
        {head}
      </div>
      <ol className="space-y-2 text-[14px]">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-2.5">
            <span className="num mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full border border-line text-[11px] text-ink-2">{i + 1}</span>
            <span>{s}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Level({ tone, head, body }: { tone: "ice" | "bad"; head: string; body: string }) {
  return (
    <div className="flex gap-3 rounded-xl border border-line bg-surface p-4">
      <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${tone === "ice" ? "bg-ice-soft text-ice" : "bg-bad-soft text-bad"}`} aria-hidden>
        {tone === "ice" ? <IconSnow size={16} /> : <IconAlert size={16} />}
      </span>
      <div>
        <div className={`text-[13.5px] font-semibold ${tone === "ice" ? "text-ice" : "text-bad"}`}>{head}</div>
        <p className="mt-0.5 text-[13.5px] text-ink-2">{body}</p>
      </div>
    </div>
  );
}
