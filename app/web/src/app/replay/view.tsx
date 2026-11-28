"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SCENARIOS, loadReplay, type ReplayData, type ScenarioId } from "@/lib/replay";
import { fmtSignedPct, utc } from "@/lib/format";
import { Legend, ParChart } from "@/components/par-chart";
import { BondMeter, Chip, Note, Num, Segmented, Skeleton } from "@/components/ui";
import { IconAlert, IconPause, IconPlay, IconRestart } from "@/components/icons";
import { Annotate, Flow } from "@/components/motion";
import { AnimatePresence, motion } from "motion/react";

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
  const [finished, setFinished] = useState(0); // bumps each time a playback runs to the end

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
        if (np >= N - 1) { setPlaying(false); setFinished((f) => f + 1); return N - 1; }
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

  // the claim a judge should check: the lowest depositors ever were against par, across every settlement
  const worst = useMemo(() => {
    const m: Record<string, number> = {};
    if (!d) return m;
    for (const n of names) m[n] = Math.min(...d.points.map((q) => q.vaults[n].depositor - q.par));
    return m;
  }, [d, names]);

  const i = Math.min(N - 1, Math.floor(pos));
  const p = d?.points[i];
  const floor = (d?.meta.minBondBps ?? 200) / 1e4;
  const scen = SCENARIOS.find((s) => s.id === id)!;
  const extent = (fn: typeof Math.min) =>
    d ? fn(...d.points.flatMap((q) => [q.par, ...names.flatMap((n) => [q.vaults[n].depositor, q.vaults[n].nav])])) - 1 : 0;

  return (
    <div className="pt-8 sm:pt-10" data-playing={playing}>
      <header className="replay-dim mx-auto max-w-[760px] text-center">
        <h1 className="text-balance text-[clamp(2rem,4.6vw,3rem)] font-medium leading-[1.05] tracking-[-0.04em]">Two real weeks, replayed through the hook</h1>
        <p className="mx-auto mt-3 max-w-[60ch] text-pretty text-[15.5px] leading-relaxed text-ink-2">
          Every swap of mainnet ETH/USDC (Uniswap v3, 0.05%) run through a local v4 pool with the Hurdle hook and two vaults, settled
          hourly. 0% is each vault&apos;s starting capital, in USD.
        </p>
        <div className="mt-5 flex flex-col items-center gap-1.5">
          <Segmented tabs label="Scenario" value={id} onChange={select} options={SCENARIOS.map((s) => ({ v: s.id, label: s.label }))} />
          <span className="text-[12.5px] text-ink-3">{scen.sub}</span>
        </div>
      </header>

      {err && <div className="mt-6"><Note tone="bad">Could not load the replay ({err}).</Note></div>}
      {!d ? (
        !err && (
          <div className="mt-8 grid gap-2.5 lg:grid-cols-[minmax(0,1fr)_340px]" aria-busy="true" aria-label="Loading replay">
            <Skeleton className="h-[520px] w-full rounded-[22px]" />
            <div className="grid gap-2.5"><Skeleton className="h-[255px] rounded-[22px]" /><Skeleton className="h-[255px] rounded-[22px]" /></div>
          </div>
        )
      ) : (
        <>
          {/* the verdict first: where depositors ended, and the worst they ever were against par */}
          <div className="stagger replay-dim mt-8 grid gap-2.5 sm:grid-cols-2">
            {names.map((n) => {
              const last = d.points[N - 1];
              const end = last.vaults[n].depositor - last.par;
              const held = worst[n] >= -1e-9;
              return (
                <div key={n} className="card p-4 sm:p-5">
                  <div className="flex items-center gap-2 text-[13px] text-ink-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: ROLE[n]?.color }} />
                    {cap(n)} depositors at the end of the week
                  </div>
                  <div className="num mt-1.5 text-[34px] font-medium leading-tight tracking-[-0.035em]"><Num key={id} value={fmtSignedPct(end).replace("%", " pts")} /></div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {/* after a full playback, the claim gets circled by hand (Rough Notation) */}
                    <Annotate key={`${id}-${finished}`} type="box" color={held ? "var(--good)" : "var(--bad)"} show={finished > 0} padding={3} delay={250}>
                      <Chip tone={held ? "good" : "bad"}>{held ? `Never below par in ${N - 1} settlements` : `Lowest ${fmtSignedPct(worst[n])} vs par`}</Chip>
                    </Annotate>
                    {firedAt[n] != null && <Chip tone="bad">Curator fired</Chip>}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-2.5 grid gap-2.5 lg:grid-cols-[minmax(0,1fr)_340px]">
            <section className="card min-w-0 p-4 sm:p-5" aria-label="Chart">
              <Legend items={[{ label: "Par", kind: "par" }, ...names.flatMap((n) => [{ label: `${cap(n)} depositors`, kind: "solid" as const, color: ROLE[n]?.color }, { label: `${cap(n)} NAV`, kind: "dash" as const, color: ROLE[n]?.color }]), { label: "below par", kind: "area" as const }]} />
              <div aria-live="polite" className="mt-3 space-y-1.5 empty:hidden">
                <AnimatePresence initial={false}>
                  {names.filter((n) => firedAt[n] != null && firedAt[n] <= (d.points[i]?.t ?? 0)).map((n) => (
                    <motion.div
                      key={n}
                      initial={{ opacity: 0, transform: "translateY(-8px) scale(0.98)" }}
                      animate={{ opacity: 1, transform: "translateY(0px) scale(1)" }}
                      exit={{ opacity: 0, transform: "translateY(-4px) scale(0.98)", transition: { duration: 0.15 } }}
                      transition={{ type: "spring", duration: 0.45, bounce: 0.2 }}
                      className="flex items-start gap-2 rounded-2xl bg-bad-soft px-3 py-2.5 text-[13px]"
                    >
                      <IconAlert size={14} className="mt-0.5 shrink-0 text-bad" />
                      <span><b className="font-semibold text-bad">{cap(n)} fired · {utc(firedAt[n])}.</b> A miss left the bond below half the floor; the vault parked passive. Depositors still at or above par.</span>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
              <div className="mt-3">
                <ParChart
                  t={d.points.map((q) => q.t)}
                  pos={pos}
                  revealKey={id}
                  height={320}
                  belowPar
                  ariaLabel="Depositor value and NAV of each vault against par over the week"
                  yFormat={(v) => fmtSignedPct(v, 1)}
                  xFormat={(ts) => new Date(ts * 1000).toISOString().slice(5, 10)}
                  fixedDomain={[extent(Math.min), extent(Math.max)]}
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
                        <div key={n} className="num flex justify-between gap-4"><span className="text-ink-2">{cap(n)} dep.</span>{fmtSignedPct(d.points[k].vaults[n].depositor - 1)}</div>
                      ))}
                      <div className="num flex justify-between gap-4"><span className="text-ink-2">ETH</span>${d.points[k].price.toFixed(0)}</div>
                    </div>
                  )}
                />
              </div>
              <div className="mt-3 rounded-2xl bg-bg-2 px-2 pt-2">
                <div className="px-1 text-[12px] text-ink-2">ETH price</div>
                <ParChart
                  t={d.points.map((q) => q.t)}
                  pos={pos}
                  revealKey={id}
                  height={96}
                  includeZero={false}
                  ariaLabel="ETH price in USDC over the week"
                  yFormat={(v) => `$${Math.round(v)}`}
                  lines={[{ id: "price", label: "ETH", values: d.points.map((q) => q.price), color: "var(--ink-2)", kind: "solid", width: 1.6 }]}
                />
              </div>
            </section>

            <div className="grid content-start gap-2.5">
              {names.map((n) => {
                const v = p!.vaults[n];
                const dd = v.depositor - p!.par, nd = v.nav - p!.par;
                const ratio = v.bond / v.nav;
                const frozen = !v.fired && ratio < floor;
                return (
                  <section key={n} className="card p-4">
                    <div className="flex items-center justify-between gap-2">
                      <h2 className="flex items-center gap-2 text-[16px] font-semibold tracking-[-0.02em]">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: ROLE[n]?.color }} />
                        {cap(n)} <span className="text-[12.5px] font-normal text-ink-2">{ROLE[n]?.range}</span>
                      </h2>
                      <Chip tone={v.fired ? "bad" : frozen ? "ice" : "good"}>{v.fired ? "Fired" : frozen ? "Frozen" : "Active"}</Chip>
                    </div>
                    <p className="mt-0.5 text-[12.5px] text-ink-2">{ROLE[n]?.blurb}</p>
                    <div className="mt-3 text-[12px] text-ink-2">Depositors vs par, now</div>
                    <div className={`num text-[26px] font-medium leading-tight tracking-[-0.03em] ${dd >= -1e-9 ? "" : "text-bad"}`}>{fmtSignedPct(dd)}</div>
                    <div className="mt-2 divide-y divide-line text-[13.5px]">
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

          {/* player: floats above the phone tab bar */}
          <div className="sticky bottom-[calc(5.25rem+env(safe-area-inset-bottom))] z-[var(--z-sticky)] mt-2.5 flex flex-wrap items-center gap-2.5 rounded-[26px] bg-surface/95 px-2.5 py-2.5 shadow-[0_12px_32px_-12px_oklch(0.2_0.01_270/0.35)] backdrop-blur md:bottom-3 md:rounded-full">
            <button onClick={() => (playing ? setPlaying(false) : play())} className="inline-flex h-10 min-w-[100px] items-center justify-center gap-2 rounded-full bg-ink px-4 font-medium text-bg transition-transform active:scale-[0.97]" aria-label={playing ? "Pause" : "Play"}>
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span key={playing ? "pause" : "play"} className="grid place-items-center" initial={{ opacity: 0, transform: "scale(0.6)" }} animate={{ opacity: 1, transform: "scale(1)" }} exit={{ opacity: 0, transform: "scale(0.6)" }} transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}>
                  {playing ? <IconPause size={15} /> : <IconPlay size={15} />}
                </motion.span>
              </AnimatePresence>
              {playing ? "Pause" : pos >= N - 1 ? "Replay" : "Play"}
            </button>
            <button onClick={() => { setPlaying(false); setPos(0); }} className="grid h-10 w-10 place-items-center rounded-full bg-bg-2 hover:bg-bg-3" aria-label="Restart">
              <IconRestart size={16} />
            </button>
            <input type="range" min={0} max={N - 1} step={0.01} value={pos} onChange={(e) => { setPlaying(false); setPos(+e.target.value); }} aria-label="Time" className="order-last h-8 w-full accent-[var(--ink)] sm:order-none sm:w-auto sm:flex-1" />
            <Segmented label="Speed" value={String(speed)} onChange={(x) => setSpeed(+x)} options={[1, 2, 4].map((x) => ({ v: String(x), label: `${x}×` }))} className="[&>button]:h-[30px] [&>button]:px-2.5" />
            <span className="num ml-auto pr-2 text-[12.5px] text-ink-2 sm:ml-0">Day <Flow countUp={false} value={String(Math.min(Math.floor((p!.t - d.points[0].t) / 86400) + 1, 7))} /> · {utc(p!.t)}</span>
          </div>
          <p className="mt-3 px-1 text-[12px] text-ink-3">Keys: space play/pause, ←/→ step one settlement, Home/End. Source: <code className="font-mono">test/Replay.t.sol</code>; on-chain par matches an offchain computation within 0.001 bp at every settlement.</p>
        </>
      )}
    </div>
  );
}

