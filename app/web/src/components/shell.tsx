"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { HurdleMark, IconMenu, IconMoon, IconSun, IconX } from "./icons";
import { useTheme } from "./providers";
import { D, addrUrl } from "@/lib/chain";

const NAV = [
  { href: "/vaults", label: "Vaults" },
  { href: "/create", label: "Create" },
  { href: "/swap", label: "Swap" },
  { href: "/replay", label: "Replay" },
  { href: "/integrate", label: "Integrate" },
];

export function Header() {
  const path = usePathname();
  const { mode, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  const active = (h: string) => path === h || path.startsWith(h + "/");

  return (
    <header className="sticky top-0 z-[var(--z-sticky)] border-b border-line bg-bg/90 backdrop-blur-md supports-[backdrop-filter]:bg-bg/75">
      <div className="mx-auto flex h-15 max-w-[1200px] items-center gap-3 px-4 sm:gap-6 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2 rounded-md font-semibold tracking-tight" aria-label="Hurdle home">
          <HurdleMark size={26} />
          <span className="text-[17px]">Hurdle</span>
        </Link>
        <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={active(n.href) ? "page" : undefined}
              className={`relative rounded-md px-3 py-1.5 text-[14px] transition-colors duration-150 ${
                active(n.href) ? "text-ink" : "text-ink-2 hover:bg-bg-2 hover:text-ink"
              }`}
            >
              {n.label}
              {active(n.href) && <span className="bar-hatch absolute inset-x-3 -bottom-[11px] h-[3px] rounded-full" />}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[12px] text-ink-2 lg:flex">
            <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-good" />
            Unichain Sepolia
          </span>
          <button
            type="button"
            onClick={toggle}
            className="grid h-9 w-9 place-items-center rounded-md border border-line text-ink-2 transition-colors hover:border-line-2 hover:text-ink"
            aria-label={mode === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            {mode === "dark" ? <IconSun /> : <IconMoon />}
          </button>
          <ConnectButton chainStatus="icon" accountStatus={{ smallScreen: "avatar", largeScreen: "address" }} showBalance={false} label="Connect" />
          <button
            type="button"
            className="grid h-9 w-9 place-items-center rounded-md border border-line text-ink md:hidden"
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
        <nav id="mobile-nav" aria-label="Main" className="fade-in border-t border-line bg-bg px-4 pb-3 pt-2 md:hidden">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={active(n.href) ? "page" : undefined}
              className={`flex items-center justify-between rounded-md px-3 py-3 text-[16px] ${active(n.href) ? "bg-bg-2 font-semibold" : "text-ink-2"}`}
            >
              {n.label}
              {active(n.href) && <span className="bar-hatch h-2 w-6 rounded-full" />}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}

export function Footer() {
  return (
    <footer className="mt-24 border-t border-line">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-4 px-4 py-8 text-[13px] text-ink-2 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex items-center gap-2">
          <HurdleMark size={18} />
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
