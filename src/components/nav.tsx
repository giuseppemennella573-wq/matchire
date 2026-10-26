"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/app", label: "Overview" },
  { href: "/app/inbox", label: "Inbox" },
  { href: "/app/calendar", label: "Calendar" },
  { href: "/app/prices", label: "Price list" },
  { href: "/app/partners", label: "Partners" },
  { href: "/app/settings", label: "Settings" },
];

export function Nav({ attention, admin }: { attention: number; admin: { waiting: number } | null }) {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="Main">
      {LINKS.map((l) => {
        const active = l.href === "/app" ? path === "/app" : path.startsWith(l.href);
        return (
          <Link key={l.href} href={l.href} aria-current={active ? "page" : undefined}>
            {l.label}
            {l.href === "/app/inbox" && attention > 0 && <span className="count" aria-label={`${attention} need you`}>{attention}</span>}
          </Link>
        );
      })}
      {admin && (
        <Link href="/app/admin" aria-current={path.startsWith("/app/admin") ? "page" : undefined}>
          Early access
          {admin.waiting > 0 && <span className="count" aria-label={`${admin.waiting} waiting`}>{admin.waiting}</span>}
        </Link>
      )}
    </nav>
  );
}
