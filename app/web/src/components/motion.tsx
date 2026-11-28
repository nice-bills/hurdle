"use client";

/**
 * Motion kit (see design/mockups/v2/MOTION.md). Libraries from the webdev.teknium.io catalog:
 *  - NumberFlow  (@number-flow/react)        numbers roll digit by digit and count up on first view
 *  - Paper Shaders (@paper-design/shaders-react)  the hero's slow dither field
 *  - Rough Notation (rough-notation)         one hand-drawn underline / box, drawn once
 *  - Motion (motion)                          sliding nav indicators, tx step changes, replay callouts
 *  - AutoAnimate (@formkit/auto-animate)      new settle / keeper rows slide in (used at the list)
 * Everything respects prefers-reduced-motion and animates transform / opacity only.
 */

import NumberFlow, { NumberFlowGroup } from "@number-flow/react";
import { fmtDuration } from "@/lib/format";
import { Dithering } from "@paper-design/shaders-react";
import { MotionConfig, useReducedMotion, useSpring } from "motion/react";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { annotate } from "rough-notation";
import { useTheme } from "./providers";

export function MotionRoot({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}

/** true once the element has been at least partly on screen (never flips back). Returns a callback ref, so it follows
 *  the element even when a skeleton is swapped for the real thing. */
export function useSeen<T extends Element>(margin = "0px 0px -8% 0px") {
  const [el, setEl] = useState<T | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (!el || seen) return;
    if (typeof IntersectionObserver === "undefined") return setSeen(true);
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setSeen(true), { rootMargin: margin });
    io.observe(el);
    return () => io.disconnect();
  }, [el, seen, margin]);
  return [setEl as (node: T | null) => void, seen, el] as const;
}

const NUM_RE = /^([^\d]*?)(\d[\d,]*)(?:\.(\d+))?([\s\S]*)$/;

/**
 * A formatted number ("$6.90", "+1.57 pts", "2.41%") that rolls when it changes and counts up from 0 the first time
 * it scrolls into view. The text is parsed back from the app's own formatters, so what is shown never differs from
 * the static string; screen readers and tests read that string from a visually hidden copy.
 */
export function Flow({ value, dim = false, countUp = true, className = "" }: { value: string; dim?: boolean; countUp?: boolean; className?: string }) {
  const [ref, seen] = useSeen<HTMLSpanElement>();
  const m = value.match(NUM_RE);
  if (!m) return <span className={className}>{value}</span>;
  const [, prefix, int, frac = "", suffix] = m;
  const n = Number(int.replace(/,/g, "") + (frac ? "." + frac : ""));
  if (!Number.isFinite(n)) return <span className={className}>{value}</span>;
  const shown = !countUp || seen ? n : 0;
  return (
    <span ref={ref} className={`relative inline-block ${className}`}>
      <span className="sr-only">{value}</span>
      <span aria-hidden="true">
      <NumberFlow
        className={`flow ${dim ? "flow-dim" : ""}`}
        value={shown}
        prefix={prefix || undefined}
        suffix={suffix || undefined}
        format={{ minimumFractionDigits: frac.length, maximumFractionDigits: frac.length, useGrouping: int.includes(",") }}
        transformTiming={{ duration: 750, easing: "cubic-bezier(0.23, 1, 0.32, 1)" }}
        spinTiming={{ duration: 750, easing: "cubic-bezier(0.23, 1, 0.32, 1)" }}
        opacityTiming={{ duration: 300, easing: "ease-out" }}
      />
      </span>
    </span>
  );
}

/** Hero background: Paper Shaders' ordered dither, slow, theme-coloured, drifting a little toward the pointer. */
export function HeroField() {
  const { mode } = useTheme();
  const reduce = useReducedMotion();
  const [ref, seen] = useSeen<HTMLDivElement>("0px");
  const [ok, setOk] = useState(false);
  const ox = useSpring(0, { stiffness: 40, damping: 18 });
  const oy = useSpring(0, { stiffness: 40, damping: 18 });
  const [off, setOff] = useState({ x: 0, y: 0 });
  useEffect(() => {
    // WebGL only where it is cheap to keep running: skip on small touch screens (battery) and without WebGL.
    const small = matchMedia("(max-width: 640px)").matches;
    let gl = false;
    try { gl = Boolean(document.createElement("canvas").getContext("webgl2")); } catch { gl = false; }
    setOk(gl && !small);
  }, []);
  useEffect(() => {
    if (reduce || !matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    const onMove = (e: PointerEvent) => {
      ox.set((e.clientX / innerWidth - 0.5) * 0.08);
      oy.set((e.clientY / innerHeight - 0.5) * 0.06);
    };
    const ux = ox.on("change", (x) => setOff((o) => ({ ...o, x })));
    const uy = oy.on("change", (y) => setOff((o) => ({ ...o, y })));
    addEventListener("pointermove", onMove, { passive: true });
    return () => { removeEventListener("pointermove", onMove); ux(); uy(); };
  }, [reduce, ox, oy]);
  const front = mode === "dark" ? "rgba(92, 204, 133, 0.17)" : "rgba(47, 154, 92, 0.16)";
  return (
    <div ref={ref} aria-hidden className="hero-field pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      {ok && seen && (
        <Dithering
          className="hero-field-canvas h-full w-full"
          colorBack="#00000000"
          colorFront={front}
          shape="warp"
          type="4x4"
          size={2.5}
          speed={reduce ? 0 : 0.22}
          scale={1.4}
          offsetX={off.x}
          offsetY={off.y}
          minPixelRatio={1}
          maxPixelCount={1600 * 900}
        />
      )}
    </div>
  );
}

type AnnotateType = "underline" | "box" | "circle" | "highlight";
/** Rough Notation: one hand-drawn mark, drawn once when `show` turns true (and on view). */
export function Annotate({ children, type = "underline", color = "var(--bar)", show = true, delay = 0, padding = 2, className = "" }: {
  children: ReactNode; type?: AnnotateType; color?: string; show?: boolean; delay?: number; padding?: number; className?: string;
}) {
  const [ref, seen, el] = useSeen<HTMLSpanElement>();
  const reduce = useReducedMotion();
  useEffect(() => {
    if (!el || !seen || !show) return;
    const resolved = color.startsWith("var(") ? getComputedStyle(el).getPropertyValue(color.slice(4, -1)).trim() || "currentColor" : color;
    const a = annotate(el, { type, color: resolved, strokeWidth: type === "underline" ? 2.5 : 2, padding, iterations: 1, animate: !reduce, animationDuration: 700, multiline: true });
    const t = setTimeout(() => a.show(), delay);
    return () => { clearTimeout(t); a.remove(); };
  }, [seen, show, type, color, delay, padding, reduce, el]);
  return <span ref={ref} className={className}>{children}</span>;
}

/** Words that rise in one after another (CSS animation, off the main thread). `from` offsets the stagger index. */
export function WordsIn({ text, from = 0, step = 40, base = 0 }: { text: string; from?: number; step?: number; base?: number }) {
  const words = text.split(" ").filter(Boolean);
  return (
    <>
      {words.map((w, i) => (
        <Fragment key={i}>
          <span className="word-in" style={{ animationDelay: `${base + (from + i) * step}ms` }}>{w}</span>
          {i < words.length - 1 ? " " : null}
        </Fragment>
      ))}
    </>
  );
}

/** Epoch countdown in fmtDuration's shape ("59m 07s"), each unit rolling as the seconds tick. */
export function Countdown({ sec, className = "" }: { sec: number; className?: string }) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const t = { duration: 450, easing: "cubic-bezier(0.23, 1, 0.32, 1)" };
  const unit = (v: number, suffix: string, pad: boolean) => (
    <NumberFlow className="flow" value={v} suffix={suffix} format={{ minimumIntegerDigits: pad ? 2 : 1 }} transformTiming={t} spinTiming={t} trend={-1} />
  );
  return (
    <span className={`relative inline-block whitespace-nowrap ${className}`}>
      <span className="sr-only">{fmtDuration(s)}</span>
      <span aria-hidden="true">
      <NumberFlowGroup>
        {h > 0 ? <>{unit(h, "h", false)} {unit(m, "m", true)}</> : m > 0 ? <>{unit(m, "m", false)} {unit(r, "s", true)}</> : unit(r, "s", false)}
      </NumberFlowGroup>
      </span>
    </span>
  );
}
