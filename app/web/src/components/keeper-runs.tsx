"use client";

import { txUrl } from "@/lib/chain";
import { ERROR_TEXT } from "@/lib/errors";
import { ago } from "@/lib/format";
import type { KeeperRun } from "@/lib/types";
import { IconExternal } from "./icons";
import { useAutoAnimate } from "@formkit/auto-animate/react";

/** First sentence of the human explanation of a decoded revert name. */
const reasonText = (name: string) => (ERROR_TEXT[name] ?? "").split(/(?<=\.)\s/)[0];

const CuratorTag = ({ action }: { action: string }) =>
  action.startsWith("curator_") ? <span className="mr-1 rounded-full bg-bg-3 px-1.5 py-px text-[11px] font-medium text-ink-2">curator</span> : null;

export function KeeperRuns({ runs }: { runs: KeeperRun[] }) {
  // AutoAnimate: a fresh keeper run slides in at the top
  const [list] = useAutoAnimate<HTMLUListElement>({ duration: 320, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
  return (
    <ul ref={list} className="rows text-[13px]">
      {runs.map((k, i) => (
        <li key={k.tx ?? `${k.ts}-${k.action}-${i}`} className={`flex items-center justify-between gap-3 py-2 ${k.skipped ? "text-ink-3" : ""}`}>
          {k.skipped ? (
            <span className="min-w-0" title={k.note ? reasonText(k.note) : undefined}>
              <CuratorTag action={k.action} />{k.action} <span className="rounded-full bg-bg-3 px-1.5 py-px text-[11px] font-medium">skipped</span>
              {k.note ? <span> · {k.note}{reasonText(k.note) ? <span className="hidden sm:inline">: {reasonText(k.note)}</span> : null}</span> : null}
            </span>
          ) : (
            <span className={k.ok ? "" : "text-bad"}><CuratorTag action={k.action} />{k.action}{k.note ? <span className="text-ink-2"> · {k.note}</span> : null}</span>
          )}
          <span className="flex shrink-0 items-center gap-2 text-ink-2">{ago(k.ts)}{k.tx && <a href={txUrl(k.tx)} target="_blank" rel="noreferrer" aria-label="Open keeper transaction"><IconExternal size={13} /></a>}</span>
        </li>
      ))}
    </ul>
  );
}
