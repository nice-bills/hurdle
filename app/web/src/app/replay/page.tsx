import type { Metadata } from "next";
import { Suspense } from "react";
import { ReplayView } from "./view";

export const metadata: Metadata = { title: "Replay" };
export default function Page() {
  return (
    <Suspense>
      <ReplayView />
    </Suspense>
  );
}
