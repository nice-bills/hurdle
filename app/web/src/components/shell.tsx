"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { HurdleMark, IconChart, IconHome, IconMenu, IconMoon, IconSun, IconSwap, IconVaults, IconX } from "./icons";
import { useTheme } from "./providers";
import { D, addrUrl } from "@/lib/chain";

const NAV = [
  { href: "/vaults", label: "Vaults" },
  { href: "/create", label: "Create" },
  { href: "/swap", label: "Swap" },
  { href: "/replay", label: "Replay" },
  { href: "/integrate", label: "Integrate" },
];

/** Phone tab bar (the reference's floating pill): the four places a depositor goes. The rest live in the menu. */
const TABS = [
  { href: "/", label: "Home", icon: IconHome },
  { href: "/vaults", label: "Vaults", icon: IconVaults },
  { href: "/swap", label: "Swap", icon: IconSwap },
  { href: "/replay", label: "Replay", icon: IconChart },
];

export function Header() {
  const path = usePathname();
  const { mode, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  const active = (h: string) => path === h || path.startsWith(h + "/");

  return (
    <header className="sticky top-0 z-[var(--z-sticky)] bg-bg/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1240px] items-center gap-3 px-4 sm:gap-5 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2 rounded-md font-semibold tracking-[-0.02em]" aria-label="Hurdle home">
          <HurdleMark size={22} />
          <span className="text-[18px]">Hurdle</span>
        </Link>
        <nav aria-label="Main" className="hidden items-center rounded-full bg-bg-3 p-[3px] md:flex">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={active(n.href) ? "page" : undefined}
              className={`rounded-full px-3.5 py-1.5 text-[13.5px] transition-colors duration-150 ${
                active(n.href) ? "bg-surface font-medium text-ink shadow-[0_1px_2px_oklch(0_0_0/0.08)]" : "text-ink-2 hover:text-ink"
              }`}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden items-center gap-2 text-[13px] text-ink-2 lg:flex">
            <span className="pulse-dot h-[7px] w-[7px] rounded-full bg-bar" />
            Unichain Sepolia
          </span>
          <button
            type="button"
            onClick={toggle}
            className="grid h-10 w-10 place-items-center rounded-full bg-surface text-ink-2 transition-colors hover:text-ink"
            aria-label={mode === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            {mode === "dark" ? <IconSun /> : <IconMoon />}
          </button>
          <ConnectButton chainStatus="icon" accountStatus={{ smallScreen: "avatar", largeScreen: "address" }} showBalance={false} label="Connect" />
          <button
            type="button"
            className="grid h-10 w-10 place-items-center rounded-full bg-surface text-ink md:hidden"
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? <IconX /> : <IconMenu />}
          </button>
        </div>
      </div>
      {open && (
        <nav id="mobile-nav" aria-label="Main" className="fade-in mx-4 mb-3 rounded-[22px] bg-surface p-2 md:hidden">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={active(n.href) ? "page" : undefined}
              className={`flex items-center justify-between rounded-2xl px-4 py-3 text-[16px] ${active(n.href) ? "bg-bg-2 font-medium" : "text-ink-2"}`}
            >
              {n.label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}

export function TabBar() {
  const path = usePathname();
  const on = (h: string) => (h === "/" ? path === "/" : path === h || path.startsWith(h + "/"));
  return (
    <nav aria-label="Sections" className="fixed inset-x-4 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] z-[var(--z-sticky)] flex justify-around rounded-full bg-surface p-1.5 shadow-[0_12px_32px_-12px_oklch(0.2_0.01_270/0.35)] md:hidden">
      {TABS.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          aria-current={on(href) ? "page" : undefined}
          className={`grid min-w-[64px] justify-items-center gap-0.5 rounded-full px-2 py-1.5 text-[11px] ${on(href) ? "text-ink" : "text-ink-3"}`}
        >
          <Icon size={21} />
          {label}
        </Link>
      ))}
    </nav>
  );
}

export function Footer() {
  return (
    <footer className="mt-20 pb-[calc(7rem+env(safe-area-inset-bottom))] md:pb-0">
      <div className="mx-auto flex max-w-[1240px] flex-col gap-4 px-4 py-8 text-[13px] text-ink-2 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex items-center gap-2">
          <HurdleMark size={16} />
          <span>Hurdle · Uniswap v4 hook · Unichain Sepolia testnet, mock tokens, not audited.</span>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <a className="hover:text-ink" href={addrUrl(D.hook)} target="_blank" rel="noreferrer">Hook on Uniscan</a>
          <a className="hover:text-ink" href="https://github.com/nice-bills/hurdle" target="_blank" rel="noreferrer">Source</a>
          <Link className="hover:text-ink" href="/integrate">Docs</Link>
        </div>
      </div>
    </footer>
  );
}
