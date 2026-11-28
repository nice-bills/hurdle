import type { Metadata, Viewport } from "next";
import { Host_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { Footer, Header, TabBar } from "@/components/shell";
import { MotionRoot } from "@/components/motion";

const sans = Host_Grotesk({ subsets: ["latin"], variable: "--font-host", display: "swap", weight: ["400", "500", "600", "700"] });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jbm", display: "swap", weight: ["400", "500"] });

export const metadata: Metadata = {
  title: { default: "Hurdle: curators that beat par or pay", template: "%s · Hurdle" },
  description:
    "A Uniswap v4 hook and curator vault: the curator guarantees depositors at least par (a passive full-range LP the pool computes itself), pays misses from a bond and earns carry only above par.",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#eeeef0" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0c0c" },
  ],
};

// Applies the saved theme before first paint (no flash).
const themeScript = `try{var t=localStorage.getItem('hurdle-theme');if(t==='dark'||t==='light')document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${sans.variable} ${mono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh">
        <Providers>
          <MotionRoot>
          <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[var(--z-toast)] focus:rounded-md focus:bg-surface focus:px-3 focus:py-2">
            Skip to content
          </a>
          <Header />
          <main id="main" className="mx-auto w-full max-w-[1240px] px-4 sm:px-6">
            {children}
          </main>
          <Footer />
          <TabBar />
          </MotionRoot>
        </Providers>
      </body>
    </html>
  );
}
