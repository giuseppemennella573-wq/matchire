"use client";

import { useState } from "react";

/** Copies the current text of a textarea (by id), so edits are included. */
export function CopyButton({ target, text, label = "Copy" }: { target?: string; text?: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      onClick={async () => {
        const el = target ? (document.getElementById(target) as HTMLTextAreaElement | HTMLInputElement | null) : null;
        const value = el?.value ?? text ?? "";
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          el?.select();
        }
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}
