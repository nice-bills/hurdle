"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SCENARIOS, loadReplay, type ReplayData, type ScenarioId } from "@/lib/replay";
import { fmtSignedPct, utc } from "@/lib/format";
import { Legend, ParChart } from "@/components/par-chart";
import { BondMeter, Note, Skeleton } from "@/components/ui";
import { IconAlert, IconPause, IconPlay, IconRestart } from "@/components/icons";

const DURATION = 24; // seconds for a full 1× playback
const ROLE: Record<string, { color: string; range: string; blurb: string }> = {
  patient: { color: "var(--v1)", range: "±10%", blurb: "holds a wide range, rarely moves" },
  chaser: { color: "var(--v2)", range: "±2%", blurb: "re-centers whenever price leaves" },
};
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export function ReplayView() {
  const sp = useSearchParams();
  const router = useRouter();
  const initial = (SCENARIOS.find((s) => s.id === sp.get("s"))?.id ?? "range-week") as ScenarioId;
  const [id, setId] = useState<ScenarioId>(initial);
  const [d, setD] = useState<ReplayData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const raf = useRef(0);
  const lastTs = useRef(0);

  useEffect(() => {
    setD(null); setErr(null); setPlaying(false);
    loadReplay(id).then((x) => { setD(x); setPos(x.points.length - 1); }).catch((e) => setErr(String(e.message ?? e)));
  }, [id]);

  const N = d?.points.length ?? 0;
  useEffect(() => {
    if (!playing || !d) return;
    lastTs.current = performance.now();
    const step = (ts: number) => {
      const dt = Math.max(0, Math.min((ts - lastTs.current) / 1000, 0.1));
      lastTs.current = ts;
      setPos((p) => {
        const np = p + (dt * (N - 1) * speed) / DURATION;
        if (np >= N - 1) { setPlaying(false); return N - 1; }
        return np;
      });
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, d, N, speed]);

  const play = useCallback(() => {
    if (!d) return;
    setPos((p) => (p >= N - 1 ? 0 : p));
    setPlaying(true);
  }, [d, N]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || !d) return;
      if (e.code === "Space") { e.preventDefault(); playing ? setPlaying(false) : play(); }
      else if (e.key === "ArrowRight") { setPlaying(false); setPos((p) => Math.min(N - 1, Math.floor(p) + 1)); }
      else if (e.key === "ArrowLeft") { setPlaying(false); setPos((p) => Math.max(0, Math.ceil(p) - 1)); }
      else if (e.key === "Home") { setPlaying(false); setPos(0); }
      else if (e.key === "End") { setPlaying(false); setPos(N - 1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [d, N, playing, play]);

  const names = useMemo(() => (d ? Object.keys(d.points[0].vaults) : []), [d]);
  const firedAt = useMemo(() => {
    const m: Record<string, number> = {};
    if (!d) return m;
    for (const e of d.events ?? []) if (e.type === "fired" && m[e.vault] == null) m[e.vault] = e.t;
    for (const n of names) if (m[n] == null) { const p = d.points.find((p) => p.vaults[n].fired); if (p) m[n] = p.t; }
    return m;
  }, [d, names]);

  const select = (x: ScenarioId) => {
    setId(x);
    router.replace(`/replay?s=${x}`, { scroll: false });
  };

  const i = Math.min(N - 1, Math.floor(pos));
  const p = d?.points[i];
  const floor = (d?.meta.minBondBps ?? 200) / 1e4;

  return (
    <div className="pt-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[32px] font-bold tracking-[-0.03em]">Two real weeks</h1>
          <p className="mt-1 max-w-[68ch] text-ink-2">
            Every swap of two weeks of mainnet ETH/USDC (Uniswap v3, 0.05%) replayed through a local v4 pool with the Hurdle hook and two
            vaults, settled hourly. 1.00 is each vault&apos;s starting capital, in USD.
          </p>
        </div>
        <div role="tablist" aria-label="Scenario" className="flex rounded-lg border border-line bg-bg-2 p-1">
          {SCENARIOS.map((s) => (
            <button key={s.id} role="tab" aria-selected={id === s.id} onClick={() => select(s.id)} className={`rounded-md px-3 py-1.5 text-left text-[13.5px] transition-colors ${id === s.id ? "bg-surface shadow-sm" : "text-ink-2 hover:text-ink"}`}>
              <span className="block font-semibold">{s.label}</span>
              <span className="block text-[11.5px] text-ink-2">{s.sub}</span>
            </button>
          ))}
        </div>
      </div>

      {err && <div className="mt-6"><Note tone="bad">Could not load the replay ({err}).</Note></div>}
      {!d ? (
        <Skeleton className="mt-8 h-[520px] w-full" />
      ) : (
        <>
          <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_330px]">
            <div className="min-w-0 rounded-xl border border-line bg-surface p-4 sm:p-5">
              <Legend items={[{ label: "Par", kind: "par" }, ...names.flatMap((n) => [{ label: `${cap(n)} depositors`, kind: "solid" as const, color: ROLE[n]?.color }, { label: `${cap(n)} NAV`, kind: "dash" as const, color: ROLE[n]?.color }]), { label: "below par", kind: "area" as const }]} />
              <div aria-live="polite" className="mt-3 space-y-1.5">
                {names.filter((n) => firedAt[n] != null && firedAt[n] <= (d.points[i]?.t ?? 0)).map((n) => (
                  <div key={n} className="fade-in flex items-center gap-2 rounded-lg bg-bad-soft px-3 py-2 text-[13px]">
                    <IconAlert size={14} className="shrink-0 text-bad" />
                    <span><b className="font-semibold text-bad">{cap(n)} fired · {utc(firedAt[n])}.</b> A miss left the bond below half the floor; the vault parked passive. Depositors still at or above par.</span>
                  </div>
                ))}
              </div>
              <div className="mt-3">
                <ParChart
                  t={d.points.map((q) => q.t)}
                  pos={pos}
                  height={320}
                  belowPar
                  ariaLabel="Depositor value and NAV of each vault against par over the week"
                  yFormat={(v) => fmtSignedPct(v, 1)}
                  xFormat={(ts) => new Date(ts * 1000).toISOString().slice(5, 10)}
                  fixedDomain={[
                    Math.min(...d.points.flatMap((q) => [q.par, ...names.flatMap((n) => [q.vaults[n].depositor, q.vaults[n].nav])])) - 1,
                    Math.max(...d.points.flatMap((q) => [q.par, ...names.flatMap((n) => [q.vaults[n].depositor, q.vaults[n].nav])])) - 1,
                  ]}
                  markers={names.filter((n) => firedAt[n] != null).map((n) => ({ t: firedAt[n], label: `${cap(n)} fired`, tone: "bad" as const }))}
                  lines={[
                    { id: "par", label: "Par", values: d.points.map((q) => q.par - 1), color: "var(--bar)", kind: "par" },
                    ...names.flatMap((n) => [
                      { id: n + "-nav", label: `${n} NAV`, values: d.points.map((q) => q.vaults[n].nav - 1), color: ROLE[n]?.color ?? "var(--ink)", kind: "dash" as const },
                      { id: n + "-dep", label: `${n} depositors`, values: d.points.map((q) => q.vaults[n].depositor - 1), color: ROLE[n]?.color ?? "var(--ink)", kind: "solid" as const },
                    ]),
                  ]}
                  tooltip={(k) => (
                    <div className="space-y-0.5">
                      <div className="font-semibold">{utc(d.points[k].t)}</div>
                      <div className="num flex justify-between gap-4"><span className="text-ink-2">Par</span>{fmtSignedPct(d.points[k].par - 1)}</div>
                      {names.map((n) => (
                        <div key={n} className="num flex justify-between gap-4"><span style={{ color: ROLE[n]?.color }}>{cap(n)} dep.</span>{fmtSignedPct(d.points[k].vaults[n].depositor - 1)}</div>
                      ))}
                      <div className="num flex justify-between gap-4"><span className="text-ink-2">ETH</span>${d.points[k].price.toFixed(0)}</div>
                    </div>
                  )}
                />
              </div>
              <div className="mt-2 border-t border-line pt-2">
                <ParChart
                  t={d.points.map((q) => q.t)}
                  pos={pos}
                  height={96}
                  includeZero={false}
                  ariaLabel="ETH price in USDC over the week"
                  yFormat={(v) => `$${Math.round(v)}`}
                  lines={[{ id: "price", label: "ETH", values: d.points.map((q) => q.price), color: "var(--ink-2)", kind: "solid", width: 1.6 }]}
                />
              </div>
            </div>

            <div className="space-y-4">
              {names.map((n) => {
                const v = p!.vaults[n];
                const dd = v.depositor - p!.par, nd = v.nav - p!.par;
                const ratio = v.bond / v.nav;
                const frozen = !v.fired && ratio < floor;
                return (
                  <section key={n} className={`rounded-xl border bg-surface p-4 ${v.fired ? "border-bad/40" : frozen ? "border-ice/40" : "border-line"}`}>
                    <div className="flex items-center justify-between gap-2">
                      <h2 className="flex items-center gap-2 text-[16px] font-semibold">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: ROLE[n]?.color }} />
                        {cap(n)} <span className="text-[12.5px] font-normal text-ink-2">{ROLE[n]?.range}</span>
                      </h2>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] ${v.fired ? "bg-bad-soft text-bad" : frozen ? "bg-ice-soft text-ice" : "bg-good-soft text-good"}`}>{v.fired ? "Fired" : frozen ? "Frozen" : "Active"}</span>
                    </div>
                    <p className="mt-0.5 text-[12.5px] text-ink-2">{ROLE[n]?.blurb}</p>
                    <div className="rows mt-3 text-[13.5px]">
                      <div className="flex justify-between py-1.5"><span className="text-ink-2">Depositors vs par</span><span className={`num font-semibold ${dd >= -1e-9 ? "text-good" : "text-bad"}`}>{fmtSignedPct(dd)} {dd >= -1e-9 ? "✓" : "✗"}</span></div>
                      <div className="flex justify-between py-1.5"><span className="text-ink-2">Strategy NAV vs par</span><span className={`num font-medium ${nd >= 0 ? "text-good" : "text-bad"}`}>{fmtSignedPct(nd)}</span></div>
                      <div className="flex justify-between py-1.5"><span className="text-ink-2">Bond paid (gross)</span><span className="num font-medium">{(v.shortfall * 100).toFixed(2)}%</span></div>
                      <div className="flex justify-between py-1.5"><span className="text-ink-2">Carry earned</span><span className="num font-medium">{(v.carry * 100).toFixed(2)}%</span></div>
                    </div>
                    <div className="mt-3">
                      <div className="num mb-1.5 flex justify-between text-[12.5px]"><span className="text-ink-2">Bond / NAV</span><span className="font-medium">{(ratio * 100).toFixed(2)}%</span></div>
                      <BondMeter bondBps={ratio * 1e4} minBondBps={floor * 1e4} />
                    </div>
                  </section>
                );
              })}
            </div>
          </div>

          <div className="sticky bottom-3 z-[var(--z-sticky)] mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface/95 px-3 py-2.5 shadow-card backdrop-blur sm:px-4">
            <button onClick={() => (playing ? setPlaying(false) : play())} className="inline-flex h-10 min-w-[96px] items-center justify-center gap-2 rounded-lg bg-ink px-3 font-semibold text-bg" aria-label={playing ? "Pause" : "Play"}>
              {playing ? <IconPause size={15} /> : <IconPlay size={15} />}
              {playing ? "Pause" : pos >= N - 1 ? "Replay" : "Play"}
            </button>
            <button onClick={() => { setPlaying(false); setPos(0); }} className="grid h-10 w-10 place-items-center rounded-lg border border-line hover:bg-bg-2" aria-label="Restart">
              <IconRestart size={16} />
            </button>
            <input type="range" min={0} max={N - 1} step={0.01} value={pos} onChange={(e) => { setPlaying(false); setPos(+e.target.value); }} aria-label="Time" className="order-last h-10 w-full accent-[var(--bar)] sm:order-none sm:w-auto sm:flex-1" />
            <div className="flex rounded-lg border border-line p-0.5" role="group" aria-label="Speed">
              {[1, 2, 4].map((s) => (
                <button key={s} onClick={() => setSpeed(s)} aria-pressed={speed === s} className={`num h-8 rounded-md px-2.5 text-[13px] font-medium ${speed === s ? "bg-bg-3" : "text-ink-2"}`}>{s}×</button>
              ))}
            </div>
            <span className="num ml-auto text-[12.5px] text-ink-2 sm:ml-0">Day {Math.min(Math.floor((p!.t - d.points[0].t) / 86400) + 1, 7)} · {utc(p!.t)}</span>
          </div>
          <p className="mt-3 text-[12px] text-ink-2">Keys: space play/pause, ←/→ step one settlement, Home/End. Source: <code className="font-mono">test/Replay.t.sol</code>; on-chain par matches an offchain computation within 0.001 bp at every settlement.</p>
        </>
      )}
    </div>
  );
}
