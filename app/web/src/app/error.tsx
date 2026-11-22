"use client";

import { btn } from "@/components/ui";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="pt-24 text-center">
      <h1 className="text-[24px] font-semibold">Something broke on our side.</h1>
      <p className="mx-auto mt-2 max-w-[48ch] text-ink-2">{error.message || "Unexpected error."} Chain data is unaffected; reload to try again.</p>
      <button className={btn.primary + " mt-6"} onClick={reset}>Try again</button>
    </div>
  );
}
