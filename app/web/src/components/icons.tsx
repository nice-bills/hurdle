import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };
const base = ({ size = 16, ...p }: P) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  ...p,
});

/** The mark: a hurdle. Two legs, one striped bar. */
export function HurdleMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden>
      <defs>
        <pattern id="hm-stripe" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
          <rect width="5" height="5" fill="var(--bar)" />
          <rect width="2" height="5" fill="var(--on-bar)" opacity=".85" />
        </pattern>
      </defs>
      <rect x="6.5" y="9" width="3" height="19" rx="1" fill="currentColor" />
      <rect x="22.5" y="9" width="3" height="19" rx="1" fill="currentColor" />
      <rect x="3" y="7" width="26" height="7" rx="1.5" fill="url(#hm-stripe)" />
      <rect x="4" y="26.5" width="8" height="2" rx="1" fill="currentColor" />
      <rect x="20" y="26.5" width="8" height="2" rx="1" fill="currentColor" />
    </svg>
  );
}

export const IconSun = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
);
export const IconMoon = (p: P) => (
  <svg {...base(p)}><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z" /></svg>
);
export const IconArrow = (p: P) => (
  <svg {...base(p)}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);
export const IconExternal = (p: P) => (
  <svg {...base(p)}><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
);
export const IconCopy = (p: P) => (
  <svg {...base(p)}><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></svg>
);
export const IconCheck = (p: P) => (
  <svg {...base(p)}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
);
export const IconX = (p: P) => (
  <svg {...base(p)}><path d="M6 6l12 12M18 6L6 18" /></svg>
);
export const IconAlert = (p: P) => (
  <svg {...base(p)}><path d="M12 3 2 20h20L12 3Z" /><path d="M12 10v4M12 17h.01" /></svg>
);
export const IconSnow = (p: P) => (
  <svg {...base(p)}><path d="M12 2v20M4 7l16 10M20 7 4 17M9 3.5l3 2 3-2M9 20.5l3-2 3 2" /></svg>
);
export const IconBolt = (p: P) => (
  <svg {...base(p)}><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" /></svg>
);
export const IconClock = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
);
export const IconMenu = (p: P) => (
  <svg {...base(p)}><path d="M4 7h16M4 12h16M4 17h16" /></svg>
);
export const IconPlay = (p: P) => (
  <svg {...base(p)} fill="currentColor" stroke="none"><path d="M7 5v14l12-7L7 5Z" /></svg>
);
export const IconPause = (p: P) => (
  <svg {...base(p)} fill="currentColor" stroke="none"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
);
export const IconRestart = (p: P) => (
  <svg {...base(p)}><path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4" /></svg>
);
export const IconDownload = (p: P) => (
  <svg {...base(p)}><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
);
export const IconSwap = (p: P) => (
  <svg {...base(p)}><path d="M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4" /></svg>
);
