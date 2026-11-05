import { Suspense } from "react";
import { READ_ONLY_MESSAGE, requireVendor } from "@/lib/auth";
import { sgClock } from "@/lib/support";
import { endSupportAction } from "./admin/actions";
import { ReadOnlyNotice } from "@/components/read-only-notice";
import { get } from "@/lib/db";
import { Nav } from "@/components/nav";
import { logoutAction } from "../(auth)/actions";
import { aiEnabled } from "@/lib/ai";
import { accountsWaiting, countSignupsWaiting, isAdmin } from "@/lib/early-access";
import { Logo } from "@/components/logo";
import { emailHealth, emailReady } from "@/lib/channels";
import { formatDateTime } from "@/lib/dates";
import { backupWarning } from "@/lib/backup";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, vendor, support } = await requireVendor();
  const attention = get<{ n: number }>(
    // Drafts waiting, plus booked clients who wrote again (they get no draft, but need the vendor).
    `SELECT COUNT(DISTINCT e.id) n FROM enquiries e WHERE e.vendor_id = ?
       AND (EXISTS (SELECT 1 FROM messages m WHERE m.enquiry_id = e.id AND m.status = 'draft') OR (e.status = 'won' AND e.owner_reason LIKE 'Message from a booked client%') OR e.promised_reason IS NOT NULL)`,
    vendor.id,
  )?.n ?? 0;
  const admin = isAdmin(user);
  const email = admin ? emailHealth() : null;
  const backupWarn = admin ? backupWarning() : null;
  return (
    <div className="shell">
      <aside className="side">
        <Logo href="/app" />
        <Nav attention={attention} admin={admin ? { signups: countSignupsWaiting(), accounts: accountsWaiting().length } : null} />
        <div className="side-foot">
          <b style={{ color: "var(--ink)" }}>{vendor.name}</b>
          <span>{user.email}</span>
          <span>{aiEnabled() ? "AI drafting on" : "Rules mode: add an API key for AI"}</span>
          <form action={logoutAction}><button className="btn btn-ghost btn-sm" type="submit">Log out</button></form>
        </div>
      </aside>
      <main className="main">
        {support && (
          <form action={endSupportAction} className="alert alert-err banner support-banner" role="status">
            <span><b>Support view: {vendor.name}</b> · read-only · ends {sgClock(support.expires_at)}</span>
            <button className="btn btn-sm" type="submit">End now</button>
          </form>
        )}
        {support && <Suspense fallback={null}><ReadOnlyNotice message={READ_ONLY_MESSAGE} /></Suspense>}
        {!!vendor.is_demo && (
          <p className="alert alert-warn banner" role="status"><b>Demo account.</b> Nothing is really sent: replies and follow-ups are only simulated.</p>
        )}
        {backupWarn && (
          <p className="alert alert-warn banner" role="status">{backupWarn} <Link href="/app/admin/backups">See backups</Link></p>
        )}
        {admin && !emailReady() && (
          <p className="alert alert-err banner" role="alert">
            <b>Matchire can&apos;t send email.</b> Outbound email isn&apos;t set up, so backups, alerts, password resets and email replies aren&apos;t going out.
            Set <code>SMTP_HOST</code>, <code>SMTP_USER</code> and <code>SMTP_PASS</code> in Render.
          </p>
        )}
        {admin && emailReady() && email && !email.ok && (
          <p className="alert alert-err banner" role="alert">
            <b>Matchire can&apos;t send email{email.since ? ` (failing since ${formatDateTime(email.since)})` : ""}.</b> Backups, alerts, password resets and email replies aren&apos;t going out.
            {/535|BadCredentials|Invalid login/i.test(email.error ?? "")
              ? <> Gmail rejected the app password: create a new one at myaccount.google.com/apppasswords and paste it into <code>SMTP_PASS</code> in Render.</>
              : <> Error: {(email.error ?? "").slice(0, 200)}</>}
            {" "}Then <Link href="/app/admin/backups">take a backup</Link> to check it works.
          </p>
        )}
        {children}
      </main>
    </div>
  );
}
