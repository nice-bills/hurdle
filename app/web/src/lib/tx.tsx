"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type { Abi, Address, TransactionReceipt } from "viem";
import { useAccount } from "wagmi";
import { getAccount, simulateContract, switchChain, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { wagmiConfig } from "@/components/providers";
import { CHAIN_ID, txUrl } from "./chain";
import { decodeError, type DecodedError } from "./errors";
import { AnimatePresence, motion } from "motion/react";
import { IconAlert, IconExternal } from "@/components/icons";

export type TxPhase = "idle" | "simulating" | "signing" | "pending" | "confirmed" | "failed";
export type TxState = { phase: TxPhase; label?: string; hash?: `0x${string}`; error?: DecodedError };

export type WriteReq = { address: Address; abi: Abi | readonly unknown[]; functionName: string; args?: readonly unknown[] };

/** simulate (decodes custom errors before the wallet opens) → sign → wait, with one shared status line. */
export function useTx() {
  const qc = useQueryClient();
  const { address } = useAccount();
  const [state, setState] = useState<TxState>({ phase: "idle" });

  const run = useCallback(
    async (label: string, req: WriteReq): Promise<TransactionReceipt | null> => {
      try {
        const acct = getAccount(wagmiConfig);
        if (!acct.address) throw new Error("Connect a wallet first.");
        if (acct.chainId !== CHAIN_ID) {
          setState({ phase: "signing", label: "Switch to Unichain Sepolia" });
          await switchChain(wagmiConfig, { chainId: CHAIN_ID });
        }
        setState({ phase: "simulating", label });
        const sim = await simulateContract(wagmiConfig, { ...(req as object), account: acct.address, chainId: CHAIN_ID } as never);
        setState({ phase: "signing", label });
        const hash = await writeContract(wagmiConfig, (sim as unknown as { request: never }).request);
        setState({ phase: "pending", label, hash });
        const rc = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: CHAIN_ID });
        if (rc.status !== "success") {
          setState({ phase: "failed", label, hash, error: { title: "Reverted onchain", detail: "The transaction was mined but reverted. Open it on the explorer for the trace." } });
          return null;
        }
        setState({ phase: "confirmed", label, hash });
        // Public RPC nodes lag a few seconds behind the receipt; re-read until they catch up (stale share balance seen live).
        qc.invalidateQueries();
        for (const ms of [1500, 4000, 8000, 15000]) setTimeout(() => qc.invalidateQueries(), ms);
        return rc;
      } catch (e) {
        setState((s) => ({ phase: "failed", label, hash: s.hash, error: decodeError(e) }));
        return null;
      }
    },
    [qc],
  );

  const busy = state.phase === "simulating" || state.phase === "signing" || state.phase === "pending";
  return { run, state, busy, reset: () => setState({ phase: "idle" }), connected: Boolean(address) };
}

const STEPS: { phase: TxPhase; t: string }[] = [
  { phase: "simulating", t: "Check" },
  { phase: "signing", t: "Sign" },
  { phase: "pending", t: "Onchain" },
  { phase: "confirmed", t: "Done" },
];

/** A check mark that draws itself (stroke-dashoffset on pathLength 1). */
function DrawnCheck({ className = "" }: { className?: string }) {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden className={`check-draw ${className}`}>
      <path d="M5 12.5l4.5 4.5L19 7.5" pathLength={1} />
    </svg>
  );
}

export function TxStatus({ state, className = "" }: { state: TxState; className?: string }) {
  if (state.phase === "idle") return null;
  const map: Record<TxPhase, { t: string; cls: string }> = {
    idle: { t: "", cls: "" },
    simulating: { t: "Checking against the contract…", cls: "bg-bg-2" },
    signing: { t: "Confirm in your wallet", cls: "bg-bg-2" },
    pending: { t: "Pending onchain…", cls: "bg-bg-2" },
    confirmed: { t: "Confirmed", cls: "bg-good-soft" },
    failed: { t: state.error?.title ?? "Failed", cls: state.error?.rejected ? "bg-bg-2" : "bg-bad-soft" },
  };
  const m = map[state.phase];
  const spinning = state.phase === "simulating" || state.phase === "signing" || state.phase === "pending";
  const at = STEPS.findIndex((x) => x.phase === state.phase); // -1 when failed
  return (
    <div role="status" aria-live="polite" className={`fade-in rounded-2xl px-3.5 py-3 text-[13.5px] transition-colors duration-300 ${m.cls} ${className}`}>
      <div className="flex items-center gap-2">
        <span className="grid h-[15px] w-[15px] shrink-0 place-items-center">
          {spinning && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-ink-3 border-t-transparent" aria-hidden />}
          {state.phase === "confirmed" && <DrawnCheck className="text-good" />}
          {state.phase === "failed" && !state.error?.rejected && <IconAlert size={15} className="text-bad" />}
        </span>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={state.phase}
            className="font-semibold"
            initial={{ opacity: 0, transform: "translateY(6px)" }}
            animate={{ opacity: 1, transform: "translateY(0px)" }}
            exit={{ opacity: 0, transform: "translateY(-6px)" }}
            transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
          >
            {state.label ? `${state.label}: ` : ""}{m.t}
          </motion.span>
        </AnimatePresence>
        {state.hash && (
          <a href={txUrl(state.hash)} target="_blank" rel="noreferrer" className="ml-auto inline-flex shrink-0 items-center gap-1 font-mono text-[12px] text-ink-2 hover:text-ink">
            {state.hash.slice(0, 10)}…<IconExternal size={12} />
          </a>
        )}
      </div>
      {at >= 0 && (
        <ol className="mt-2.5 grid grid-cols-4 gap-1.5" aria-hidden>
          {STEPS.map((x, k) => (
            <li key={x.phase} className="min-w-0">
              <span className="block h-1 overflow-hidden rounded-full bg-ink/10">
                <span
                  className={`block h-full origin-left rounded-full transition-transform duration-500 ease-[var(--ease-in-out)] ${state.phase === "confirmed" ? "bg-good" : "bg-ink"}`}
                  style={{ transform: `scaleX(${k < at || state.phase === "confirmed" ? 1 : k === at ? 0.5 : 0})` }}
                />
              </span>
              <span className={`mt-1 block truncate text-[11px] transition-colors duration-300 ${k <= at ? "text-ink" : "text-ink-3"}`}>{x.t}</span>
            </li>
          ))}
        </ol>
      )}
      {state.phase === "failed" && state.error && <p className="mt-1 text-ink-2">{state.error.detail}</p>}
    </div>
  );
}
