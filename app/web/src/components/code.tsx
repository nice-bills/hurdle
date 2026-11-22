"use client";

import { useState, type ReactNode } from "react";
import { IconCheck, IconCopy } from "./icons";

const KW = new Set([
  "import", "from", "export", "const", "let", "await", "async", "function", "return", "if", "else", "for", "of", "while",
  "new", "throw", "try", "catch", "true", "false", "null", "undefined", "as", "type", "with", "continue", "break",
]);

/** A tiny TS tokenizer: comments, strings, numbers, keywords. Enough to make snippets scannable, no dependency. */
function highlight(src: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b0x[0-9a-fA-F]+\b|\b\d[\d_]*n?\b)|([A-Za-z_$][\w$]*)/g;
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push(src.slice(last, m.index));
    const [tok, c, s, n, w] = m;
    if (c) out.push(<span key={k++} className="text-ink-3 italic">{tok}</span>);
    else if (s) out.push(<span key={k++} className="text-good">{tok}</span>);
    else if (n) out.push(<span key={k++} className="text-bar-ink">{tok}</span>);
    else if (w && KW.has(w)) out.push(<span key={k++} className="text-v1 font-medium">{tok}</span>);
    else out.push(tok);
    last = m.index + tok.length;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

export function CopyButton({ text, label = "Copy", className = "" }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1400); })}
      className={`inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:border-line-2 hover:text-ink ${className}`}
      aria-label={done ? "Copied" : `${label} to clipboard`}
    >
      {done ? <IconCheck size={13} className="text-good" /> : <IconCopy size={13} />}
      {done ? "Copied" : label}
    </button>
  );
}

export function Code({ code, title, lang = "ts" }: { code: string; title?: string; lang?: string }) {
  const src = code.replace(/^\n+|\s+$/g, "");
  return (
    <figure className="m-0 overflow-hidden rounded-xl border border-line bg-bg-2">
      <figcaption className="flex items-center justify-between gap-3 border-b border-line px-3 py-1.5 sm:px-4">
        <span className="truncate font-mono text-[12px] text-ink-2">{title ?? lang}</span>
        <CopyButton text={src} />
      </figcaption>
      <pre className="overflow-x-auto px-3 py-3 font-mono text-[12.5px] leading-[1.65] text-ink sm:px-4 sm:text-[13px]" tabIndex={0}>
        <code>{lang === "ts" ? highlight(src) : src}</code>
      </pre>
    </figure>
  );
}
