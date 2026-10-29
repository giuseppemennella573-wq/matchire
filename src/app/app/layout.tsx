import { requireVendor } from "@/lib/auth";
import { get } from "@/lib/db";
import { Nav } from "@/components/nav";
import { logoutAction } from "../(auth)/actions";
import { aiEnabled } from "@/lib/ai";
import { accountsWaiting, countSignupsWaiting, isAdmin } from "@/lib/early-access";
import { Logo } from "@/components/logo";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, vendor } = await requireVendor();
  const attention = get<{ n: number }>(
    `SELECT COUNT(DISTINCT e.id) n FROM enquiries e JOIN messages m ON m.enquiry_id = e.id AND m.status = 'draft' WHERE e.vendor_id = ?`,
    vendor.id,
  )?.n ?? 0;
  return (
    <div className="shell">
      <aside className="side">
        <Logo href="/app" />
        <Nav attention={attention} admin={isAdmin(user) ? { signups: countSignupsWaiting(), accounts: accountsWaiting().length } : null} />
        <div className="side-foot">
          <b style={{ color: "var(--ink)" }}>{vendor.name}</b>
          <span>{user.email}</span>
          <span>{aiEnabled() ? "AI drafting on" : "Rules mode: add an API key for AI"}</span>
          <form action={logoutAction}><button className="btn btn-ghost btn-sm" type="submit">Log out</button></form>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
