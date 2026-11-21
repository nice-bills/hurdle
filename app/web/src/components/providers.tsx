"use client";

import "@rainbow-me/rainbowkit/styles.css";
import { RainbowKitProvider, connectorsForWallets, darkTheme, lightTheme, type Theme } from "@rainbow-me/rainbowkit";
import {
  braveWallet,
  coinbaseWallet,
  injectedWallet,
  metaMaskWallet,
  rabbyWallet,
  rainbowWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { WagmiProvider, createConfig, http } from "wagmi";
import { unichainSepolia } from "@/lib/chain";

const wcId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "";

// Without a WalletConnect project id only injected (browser-extension) wallets are offered; they need no relay.
const connectors = connectorsForWallets(
  wcId
    ? [
        { groupName: "Popular", wallets: [metaMaskWallet, rabbyWallet, rainbowWallet, coinbaseWallet, walletConnectWallet] },
        { groupName: "Other", wallets: [injectedWallet, braveWallet] },
      ]
    : [{ groupName: "Browser wallets", wallets: [injectedWallet, rabbyWallet, braveWallet] }],
  { appName: "Hurdle", projectId: wcId || "hurdle-injected-only" },
);

export const wagmiConfig = createConfig({
  chains: [unichainSepolia],
  connectors,
  transports: { [unichainSepolia.id]: http(unichainSepolia.rpcUrls.default.http[0], { batch: true }) },
  ssr: true,
});

type Mode = "light" | "dark";
const ThemeCtx = createContext<{ mode: Mode; toggle: () => void }>({ mode: "light", toggle: () => {} });
export const useTheme = () => useContext(ThemeCtx);

function readMode(): Mode {
  if (typeof document === "undefined") return "light";
  const t = document.documentElement.dataset.theme;
  if (t === "dark" || t === "light") return t;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function rkTheme(mode: Mode): Theme {
  const base = mode === "dark" ? darkTheme : lightTheme;
  const t = base({ accentColor: "var(--bar)", accentColorForeground: "var(--on-bar)", borderRadius: "small", overlayBlur: "small" });
  return {
    ...t,
    fonts: { body: "var(--font-schibsted), system-ui, sans-serif" },
    colors: {
      ...t.colors,
      modalBackground: "var(--surface)",
      modalBorder: "var(--line)",
      modalText: "var(--ink)",
      modalTextSecondary: "var(--ink-2)",
      connectButtonBackground: "var(--surface)",
      connectButtonInnerBackground: "var(--bg-2)",
      connectButtonText: "var(--ink)",
      generalBorder: "var(--line)",
    },
    shadows: { ...t.shadows, connectButton: "none" },
  };
}

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: 2 } } }));
  const [mode, setMode] = useState<Mode>("light");
  useEffect(() => {
    setMode(readMode());
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => setMode(readMode());
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const theme = useMemo(
    () => ({
      mode,
      toggle: () => {
        const next: Mode = readMode() === "dark" ? "light" : "dark";
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem("hurdle-theme", next);
        } catch {}
        setMode(next);
      },
    }),
    [mode],
  );
  return (
    <ThemeCtx.Provider value={theme}>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={qc}>
          <RainbowKitProvider theme={rkTheme(mode)} modalSize="compact" initialChain={unichainSepolia}>
            {children}
          </RainbowKitProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </ThemeCtx.Provider>
  );
}
