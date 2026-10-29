"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Item = { href: string; label: string; count?: number; countLabel?: string };

const DESK = [
  { href: "/app", label: "Overview" },
  { href: "/app/inbox", label: "Inbox" },
  { href: "/app/calendar", label: "Calendar" },
  { href: "/app/prices", label: "Price list" },
  { href: "/app/partners", label: "Partners" },
  { href: "/app/settings", label: "Settings" },
];

function Links({ items, path }: { items: Item[]; path: string }) {
  return items.map((l) => {
    // Exact match for section roots that have sub-pages listed separately.
    const exact = l.href === "/app" || l.href === "/app/admin";
    const active = exact ? path === l.href : path.startsWith(l.href);
    return (
      <Link key={l.href} href={l.href} aria-current={active ? "page" : undefined}>
        {l.label}
        {l.count ? <span className="count" aria-label={`${l.count} ${l.countLabel}`}>{l.count}</span> : null}
      </Link>
    );
  });
}

export function Nav({ attention, admin }: { attention: number; admin: { signups: number; accounts: number } | null }) {
  const path = usePathname();
  const desk: Item[] = DESK.map((l) => (l.href === "/app/inbox" ? { ...l, count: attention, countLabel: "need you" } : l));
  return (
    <nav className="nav" aria-label="Main">
      {admin && <p className="nav-label">Your desk</p>}
      <Links items={desk} path={path} />
      {admin && (
        <>
          <p className="nav-label">Matchire admin</p>
          <Links
            path={path}
            items={[
              { href: "/app/admin", label: "Early access", count: admin.signups, countLabel: "waiting" },
              { href: "/app/admin/accounts", label: "Accounts", count: admin.accounts, countLabel: "new" },
              { href: "/app/admin/backups", label: "Backups" },
            ]}
          />
        </>
      )}
    </nav>
  );
}
