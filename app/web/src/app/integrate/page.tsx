import type { Metadata } from "next";
import { IntegrateView } from "./view";

export const metadata: Metadata = {
  title: "Integrate",
  description: "Addresses, ABIs and viem snippets for Hurdle vaults on Unichain Sepolia: deposit, withdraw, settle, create, and how to run a curator bot.",
};

export default function Page() {
  return <IntegrateView />;
}
