"use client";

import { txUrl } from "@/lib/chain";
import { ERROR_TEXT } from "@/lib/errors";
import { ago } from "@/lib/format";
import type { KeeperRun } from "@/lib/types";
import { IconExternal } from "./icons";

/** First sentence of the human explanation of a decoded revert name. */
const reasonText = (name: string) => (ERROR_TEXT[name] ?? "").split(/(?<=\.)\s/)[0];

const CuratorTag = ({ action }: { action: string }) =>
  action.startsWith("curator_") ? <span className="mr-1 rounded border border-line px-1 py-px text-[11px] font-medium uppercase tracking-wide text-ink-2">curator</span> : null;

export function KeeperRuns({ runs }: { runs: KeeperRun[] }) {
  return (
    <ul className="rows text-[13px]">
      {runs.map((k, i) => (
        <li key={i} className={`flex items-center justify-between gap-3 py-2 ${k.skipped ? "text-ink-3" : ""}`}>
          {k.skipped ? (
            <span className="min-w-0" title={k.note ? reasonText(k.note) : undefined}>
              <CuratorTag action={k.action} />{k.action} <span className="rounded border border-line px-1 py-px text-[11px] font-medium uppercase tracking-wide">skipped</span>
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
