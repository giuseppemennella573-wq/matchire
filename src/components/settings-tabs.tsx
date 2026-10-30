"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Tab switching for the Settings page. Every panel is rendered on the server;
// this shows one at a time, keeps the tab in the address (#bookings), warns
// before unsaved edits are lost, and shows a "Saved" toast after a save.

type Tab = { id: string; label: string };

const fromHash = (hash: string, tabs: Tab[], fallback: string) => {
  const h = hash.replace(/^#/, "").toLowerCase();
  if (h === "password") return "account";
  return tabs.some((t) => t.id === h) ? h : fallback;
};

export function SettingsTabs({ tabs, initialTab, saved, children }: { tabs: Tab[]; initialTab: string | null; saved: boolean; children: React.ReactNode }) {
  const [active, setActive] = useState(initialTab ?? "business");
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState(saved);
  const submitting = useRef(false);
  const root = useRef<HTMLDivElement>(null);

  const label = (id: string) => tabs.find((t) => t.id === id)?.label ?? id;

  /** Switch tabs, asking first if the current one has unsaved edits (which are then discarded). */
  const go = useCallback((next: string) => {
    if (next === active) return true;
    if (dirty.has(active)) {
      if (!window.confirm(`You have unsaved changes on ${label(active)}. Leave without saving?`)) return false;
      root.current?.querySelectorAll<HTMLFormElement>(`form[data-tab-form="${active}"]`).forEach((f) => f.reset());
      setDirty((d) => { const n = new Set(d); n.delete(active); return n; });
    }
    setActive(next);
    history.replaceState(null, "", `/app/settings#${next}`);
    return true;
  }, [active, dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  // Open the tab named in the address (after a save the server says which; otherwise the #hash).
  useEffect(() => {
    if (!initialTab) setActive(fromHash(location.hash, tabs, "business"));
    else history.replaceState(null, "", `/app/settings#${initialTab}`); // drop ?tab=…&saved=1
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onHash = () => { if (!go(fromHash(location.hash, tabs, "business"))) history.replaceState(null, "", `/app/settings#${active}`); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [go, active, tabs]);

  // Track edits per tab, and warn before leaving the page with any unsaved.
  useEffect(() => {
    const el = root.current!;
    const mark = (e: Event) => {
      const form = (e.target as HTMLElement).closest<HTMLFormElement>("form[data-tab-form]");
      if (form) setDirty((d) => (d.has(form.dataset.tabForm!) ? d : new Set(d).add(form.dataset.tabForm!)));
    };
    const onSubmit = () => { submitting.current = true; };
    el.addEventListener("input", mark);
    el.addEventListener("change", mark);
    el.addEventListener("submit", onSubmit);
    return () => { el.removeEventListener("input", mark); el.removeEventListener("change", mark); el.removeEventListener("submit", onSubmit); };
  }, []);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty.size && !submitting.current) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(false), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <div ref={root} className="settings" data-tab={active} data-dirty={[...dirty].join(" ")}>
      <nav className="settings-nav" aria-label="Settings sections" role="tablist">
        {tabs.map((t) => (
          <a key={t.id} href={`#${t.id}`} role="tab" aria-selected={t.id === active} aria-current={t.id === active ? "page" : undefined}
            onClick={(e) => { e.preventDefault(); go(t.id); }}>
            {t.label}{dirty.has(t.id) && <span className="dot-unsaved" aria-label="unsaved changes" />}
          </a>
        ))}
      </nav>
      <div className="settings-body">{children}</div>
      {toast && <div className="toast" role="status">Saved</div>}
    </div>
  );
}
