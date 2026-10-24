"use client";

import { useFormStatus } from "react-dom";

/** A submit button that shows progress while its server action runs (AI calls take a few seconds). */
export function Submit({ children, pending, className = "btn btn-primary", name, value, formNoValidate }: {
  children: React.ReactNode; pending?: string; className?: string; name?: string; value?: string; formNoValidate?: boolean;
}) {
  const s = useFormStatus();
  const mine = s.pending && (!name || s.data?.get(name) === value);
  return (
    <button className={className} type="submit" name={name} value={value} disabled={s.pending} formNoValidate={formNoValidate}>
      {mine && pending ? pending : children}
    </button>
  );
}
