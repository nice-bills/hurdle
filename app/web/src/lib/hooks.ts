"use client";

import { useQuery } from "@tanstack/react-query";
import type { Overview, PoolState, VaultDetail } from "./types";

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error || `HTTP ${r.status}`);
  return j as T;
}

export const useOverview = () =>
  useQuery({ queryKey: ["overview"], queryFn: () => getJson<Overview>("/api/overview"), refetchInterval: 20_000 });

export const useVaultDetail = (address: string | null) =>
  useQuery({
    enabled: Boolean(address),
    queryKey: ["vault", (address ?? "").toLowerCase()],
    queryFn: () => getJson<VaultDetail>(`/api/vaults/${address}`),
    refetchInterval: 15_000,
    retry: (n, e) => n < 2 && !/not a Hurdle vault|not an address/.test((e as Error).message),
  });

export const usePool = () =>
  useQuery({
    queryKey: ["pool"],
    queryFn: () => getJson<PoolState & { head: number; headTs: number; source: string }>("/api/pool"),
    refetchInterval: 8_000,
  });
