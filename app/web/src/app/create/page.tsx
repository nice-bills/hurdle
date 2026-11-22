import type { Metadata } from "next";
import { Suspense } from "react";
import { CreateView } from "./view";

export const metadata: Metadata = { title: "Create a vault" };
export default function Page() {
  return (
    <Suspense>
      <CreateView />
    </Suspense>
  );
}
