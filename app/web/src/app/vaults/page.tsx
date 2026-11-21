import type { Metadata } from "next";
import { VaultsExplorer } from "./explorer";

export const metadata: Metadata = { title: "Vaults" };

export default function Page() {
  return <VaultsExplorer />;
}
