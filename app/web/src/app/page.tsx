import Link from "next/link";
import { HeroChart } from "@/components/hero-chart";
import { HomeScreens } from "@/components/home-screens";
import { IconArrow } from "@/components/icons";
import { Annotate, HeroField, WordsIn } from "@/components/motion";

export default function Home() {
  return (
    <div className="pb-8">
      <section className="relative isolate mx-auto max-w-[920px] pb-12 pt-10 text-center sm:pb-14 sm:pt-16">
        <HeroField />
        <p className="rise mb-5 inline-flex items-center gap-2 rounded-full bg-surface px-3 py-1 text-[12.5px] text-ink-2">
          <span className="bar-hatch h-[2px] w-4" />
          Uniswap v4 hook · curated liquidity
        </p>
        <h1 className="text-balance text-[clamp(2.3rem,5.4vw,3.6rem)] font-medium leading-[1.03] tracking-[-0.04em]">
          <WordsIn text="Your curator must" base={80} />{" "}
          <Annotate type="underline" delay={900} padding={1}><WordsIn text="beat par" from={3} base={80} /></Annotate>{" "}
          <WordsIn text="every hour, or their bond pays you." from={5} base={80} />
        </h1>
        <p style={{ animationDelay: "420ms" }} className="rise mx-auto mt-5 max-w-[54ch] text-pretty text-[16.5px] leading-relaxed text-ink-2">
          Par is what a passive full-range LP would have earned, read from the pool itself. A miss is paid from the
          curator&apos;s bond. Carry is earned only above par.
        </p>
        <div style={{ animationDelay: "500ms" }} className="rise mt-7 flex flex-wrap justify-center gap-2.5">
          <Link href="/vaults" className="inline-flex h-12 items-center gap-2 rounded-full bg-ink px-6 text-[15px] font-medium text-bg transition-[transform,opacity] duration-150 hover:opacity-90 active:scale-[0.97]">
            Open a vault <IconArrow size={16} />
          </Link>
          <Link href="/replay" className="inline-flex h-12 items-center rounded-full bg-surface px-6 text-[15px] font-medium transition-[transform,background-color] duration-150 hover:bg-bg-2 active:scale-[0.97]">
            Watch a real week
          </Link>
        </div>
      </section>

      <HomeScreens />

      <section className="card mt-10 p-4 sm:p-6" aria-labelledby="week">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="week" className="text-[22px] font-semibold tracking-[-0.03em]">A real week, replayed</h2>
          <span className="text-[13px] text-ink-2">Mainnet ETH/USDC swaps through the hook</span>
        </div>
        <HeroChart />
      </section>

      <section className="mt-10 grid gap-5 rounded-[28px] bg-ink p-6 text-bg sm:p-10 lg:grid-cols-[1fr_auto] lg:items-center">
        <div>
          <h2 className="text-[clamp(1.5rem,2.6vw,2rem)] font-medium tracking-[-0.03em]">Run the whole loop on testnet.</h2>
          <p className="mt-2 max-w-[60ch] text-[15px] opacity-70">
            Mint mock USDC and WETH, deposit in an open window, move the price with a swap, then settle and watch the bond
            pay or the carry accrue. Or start your own vault and post a bond.
          </p>
        </div>
        <div className="flex flex-wrap gap-2.5">
          <Link href="/vaults" className="inline-flex h-11 items-center gap-2 rounded-full bg-bg px-5 font-medium text-ink">
            Open a vault <IconArrow size={16} />
          </Link>
          <Link href="/create" className="inline-flex h-11 items-center rounded-full px-4 font-medium ring-1 ring-current/25">
            Become a curator
          </Link>
          <Link href="/integrate" className="inline-flex h-11 items-center rounded-full px-3 font-medium opacity-70 hover:opacity-100">
            Developer docs
          </Link>
        </div>
      </section>
    </div>
  );
}
