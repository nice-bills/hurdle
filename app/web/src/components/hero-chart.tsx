"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { loadReplay, type ReplayData } from "@/lib/replay";
import { fmtSignedPct } from "@/lib/format";
import { Legend, ParChart } from "./par-chart";
import { Skeleton } from "./ui";
import { IconArrow } from "./icons";

/** Real replay data drawn on load: Patient's depositors versus the hatched par bar. */
export function HeroChart() {
  const [d, setD] = useState<ReplayData | null>(null);
  const [pos, setPos] = useState<number | undefined>(undefined);
  const raf = useRef(0);
  useEffect(() => {
    loadReplay("range-week").then(setD).catch(() => {});
  }, []);
  useEffect(() => {
    if (!d) return;
    const N = d.points.length - 1;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return setPos(undefined);
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / 2600);
      const e = 1 - Math.pow(1 - k, 4);
      setPos(e * N);
      if (k < 1) raf.current = requestAnimationFrame(step);
      else setPos(undefined);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [d]);

  if (!d)
    return (
      <div className="relative h-[300px] w-full" role="status" aria-label="Loading chart">
        <Skeleton className="h-full w-full" />
        <svg aria-hidden className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
          <path d="M0 62 C12 58 20 70 32 55 S52 40 62 48 S84 30 100 34" fill="none" stroke="var(--ink-3)" strokeWidth="1.5" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
    );
  const P = d.points;
  const t = P.map((p) => p.t);
  const last = P[P.length - 1];
  const dep = last.vaults.patient.depositor - last.par;
  return (
    <figure className="m-0">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <Legend items={[{ label: "Par: passive full-range LP", kind: "par" }, { label: "Patient depositors", kind: "solid", color: "var(--ink)" }, { label: "Patient strategy NAV", kind: "dash", color: "var(--ink-2)" }]} />
      </div>
      <ParChart
        t={t}
        pos={pos}
        height={280}
        ariaLabel="Patient vault depositors versus par over a real week of ETH/USDC swaps"
        yFormat={(v) => fmtSignedPct(v, 1)}
        xFormat={(ts) => new Date(ts * 1000).toISOString().slice(5, 10)}
        lines={[
          { id: "par", label: "Par", values: P.map((p) => p.par - 1), color: "var(--bar)", kind: "par" },
          { id: "nav", label: "NAV", values: P.map((p) => p.vaults.patient.nav - 1), color: "var(--ink-2)", kind: "dash" },
          { id: "dep", label: "Depositors", values: P.map((p) => p.vaults.patient.depositor - 1), color: "var(--ink)", kind: "solid" },
        ]}
        tooltip={(i) => (
          <div className="space-y-0.5">
            <div className="font-semibold">{new Date(P[i].t * 1000).toUTCString().slice(5, 22)} UTC</div>
            <div className="num flex justify-between gap-4"><span className="text-ink-2">Par</span>{fmtSignedPct(P[i].par - 1)}</div>
            <div className="num flex justify-between gap-4"><span className="text-ink-2">Depositors</span>{fmtSignedPct(P[i].vaults.patient.depositor - 1)}</div>
            <div className="num flex justify-between gap-4"><span className="text-ink-2">ETH</span>${P[i].price.toFixed(0)}</div>
          </div>
        )}
      />
      <figcaption className="mt-3 flex flex-wrap items-baseline justify-between gap-2 text-[13px] text-ink-2">
        <span>
          Every swap of Oct 31 – Nov 6 (ETH/USDC, mainnet) replayed through the hook. Depositors end{" "}
          <b className="num font-semibold text-good">{fmtSignedPct(dep)}</b> over par, and never below it at any of 166 settlements.
        </span>
        <Link href="/replay" className="inline-flex items-center gap-1 font-medium text-ink hover:underline">
          Play both weeks <IconArrow size={14} />
        </Link>
      </figcaption>
    </figure>
  );
}
