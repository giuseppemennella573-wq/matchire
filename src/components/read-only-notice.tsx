"use client";

import { useSearchParams } from "next/navigation";

/** Shown in Support view after an action was refused (the URL carries ?readonly=1). */
export function ReadOnlyNotice({ message }: { message: string }) {
  const params = useSearchParams();
  if (params.get("readonly") !== "1") return null;
  return <p className="alert alert-warn banner" role="alert">{message}</p>;
}
