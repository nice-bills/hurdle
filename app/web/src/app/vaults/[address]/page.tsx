import type { Metadata } from "next";
import { KNOWN_LABELS } from "@/lib/chain";
import { VaultView } from "./view";

export async function generateMetadata({ params }: { params: Promise<{ address: string }> }): Promise<Metadata> {
  const { address } = await params;
  const known = KNOWN_LABELS[address.toLowerCase()];
  return { title: known ? `${known.name} vault` : `Vault ${address.slice(0, 8)}…` };
}

export default async function Page({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  return <VaultView address={address} />;
}
