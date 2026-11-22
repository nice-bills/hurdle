import Link from "next/link";
import { btn } from "@/components/ui";

export default function NotFound() {
  return (
    <div className="pt-24 text-center">
      <p className="num text-[56px] font-bold tracking-[-0.04em] text-bar-ink">404</p>
      <h1 className="mt-2 text-[24px] font-semibold">That lane is empty.</h1>
      <p className="mx-auto mt-2 max-w-[44ch] text-ink-2">The page you asked for does not exist. Try the vault list or the developer docs.</p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <Link href="/vaults" className={btn.primary}>See all vaults</Link>
        <Link href="/integrate" className={btn.ghost}>Developer docs</Link>
      </div>
    </div>
  );
}
