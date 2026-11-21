export type ReplayVault = { nav: number; depositor: number; bond: number; carry: number; shortfall: number; fired: boolean };
export type ReplayPoint = { t: number; price: number; par: number; vaults: Record<string, ReplayVault> };
export type ReplayData = {
  meta: { scenario: string; label: string; pool: string; start: string; end: string; epochSeconds: number; carryBps: number; minBondBps: number; unit: string };
  points: ReplayPoint[];
  events: { type: string; vault: string; t: number }[];
};

export const SCENARIOS = [
  { id: "range-week", label: "Range-bound week", sub: "Oct 31 – Nov 6" },
  { id: "down-week", label: "ETH −14% week", sub: "Nov 7 – 13" },
] as const;
export type ScenarioId = (typeof SCENARIOS)[number]["id"];

export async function loadReplay(id: ScenarioId): Promise<ReplayData> {
  const r = await fetch(`/replay/${id}.json`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
