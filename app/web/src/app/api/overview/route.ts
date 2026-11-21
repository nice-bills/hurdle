import { NextResponse } from "next/server";
import { getOverview } from "@/lib/server/data";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getOverview(), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
