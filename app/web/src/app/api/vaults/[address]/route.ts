import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { getVaultDetail } from "@/lib/server/data";

export const dynamic = "force-dynamic";

export async function GET(_: Request, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  if (!isAddress(address)) return NextResponse.json({ error: "not an address" }, { status: 400 });
  try {
    const d = await getVaultDetail(address);
    if (!d) return NextResponse.json({ error: "not a Hurdle vault" }, { status: 404 });
    return NextResponse.json(d, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
